/**
 * Streaming multipart parser for POST /api/pipelines/runs.
 * Stages file bytes under a private attempt directory and hashes as it writes.
 */

import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { PassThrough, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import busboy from 'busboy';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
  isSafeAttachmentName,
} from './attachments.js';

export const RUN_JSON_MAX_BYTES = 512 * 1024;
export const MULTIPART_OVERHEAD_MAX_BYTES = 1024 * 1024;
export const MULTIPART_TOTAL_MAX_BYTES = ATTACHMENT_MAX_TOTAL_BYTES + MULTIPART_OVERHEAD_MAX_BYTES;

function problem(status, message, errors = []) {
  const err = new Error(message);
  err.status = status;
  err.errors = errors;
  err.code = 'pipeline_multipart';
  return err;
}

function fieldProblem(status, field, message) {
  return problem(status, message, [{ field, message }]);
}

/**
 * Unexpected multipart field names may be hostile. Echo only short safe identifiers;
 * otherwise report a generic `field` so problem details and logs stay sanitised.
 */
export function safeUnexpectedFieldName(name) {
  if (typeof name === 'string' && /^[A-Za-z][A-Za-z0-9._-]{0,63}$/.test(name)) return name;
  return 'field';
}

/**
 * Decode filename bytes captured as a latin1 string (one char per wire byte).
 * Rejects invalid UTF-8; accepts a literal U+FFFD that was validly encoded.
 */
function decodeFilenameWireBytes(latin1) {
  try {
    for (let i = 0; i < latin1.length; i++) {
      if (latin1.charCodeAt(i) > 0xff) return { error: 'invalid filename encoding' };
    }
    // ignoreBOM: keep a leading U+FEFF so basename validation can reject format characters.
    const filename = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.from(latin1, 'latin1'));
    return { filename };
  } catch {
    return { error: 'invalid filename encoding' };
  }
}

/**
 * Percent-decode an RFC 5987 value into wire bytes, then require valid UTF-8.
 */
function decodeFilenameStar(encoded) {
  try {
    const bytes = [];
    for (let i = 0; i < encoded.length;) {
      const ch = encoded[i];
      if (ch === '%') {
        const hex = encoded.slice(i + 1, i + 3);
        if (!/^[0-9A-Fa-f]{2}$/.test(hex)) return { error: 'invalid filename encoding' };
        bytes.push(parseInt(hex, 16));
        i += 3;
        continue;
      }
      const code = encoded.charCodeAt(i);
      if (code > 0xff) return { error: 'invalid filename encoding' };
      bytes.push(code);
      i += 1;
    }
    // ignoreBOM: keep a leading U+FEFF so basename validation can reject format characters.
    const filename = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })
      .decode(Buffer.from(bytes));
    return { filename };
  } catch {
    return { error: 'invalid filename encoding' };
  }
}

/**
 * Extract the raw filename parameter from a Content-Disposition header value.
 * Treat the header as latin1 wire bytes so encoding is checked before any lossy
 * UTF-8 decode or basename conversion. Callers validate the resulting basename.
 */
export function rawMultipartFilename(contentDisposition) {
  if (typeof contentDisposition !== 'string') return null;
  const params = dispositionParameters(contentDisposition);
  if (params.malformed) return { error: 'malformed content disposition' };
  if (params.has('filename*')) {
    const match = /^UTF-8''(.+)$/i.exec(params.get('filename*'));
    if (!match) return { error: 'invalid filename encoding' };
    return decodeFilenameStar(match[1]);
  }
  if (params.has('filename')) return decodeFilenameWireBytes(params.get('filename'));
  return null;
}

/**
 * Tokenize `type; name=value; name="quoted"` into a lower-cased parameter map, so a
 * parameter is read only at a parameter boundary and never from inside a quoted value.
 * The first occurrence of a parameter wins. An unclosed quoted value, or text after a
 * closing quote, sets `malformed` and stops tokenizing.
 */
function dispositionParameters(value) {
  const params = new Map();
  let i = value.indexOf(';');
  if (i === -1) return params;
  while (i < value.length) {
    while (i < value.length && (value[i] === ';' || value[i] === ' ' || value[i] === '\t')) i += 1;
    const eq = value.indexOf('=', i);
    if (eq === -1) break;
    const name = value.slice(i, eq).trim().toLowerCase();
    i = eq + 1;
    while (i < value.length && (value[i] === ' ' || value[i] === '\t')) i += 1;
    let paramValue = '';
    if (value[i] === '"') {
      i += 1;
      while (i < value.length && value[i] !== '"') {
        // Only \" ends a quoted character; leave other backslashes so separators stay visible.
        if (value[i] === '\\' && i + 1 < value.length && value[i + 1] === '"') {
          paramValue += '"';
          i += 2;
          continue;
        }
        paramValue += value[i];
        i += 1;
      }
      if (i >= value.length) {
        // An unclosed quoted value is malformed; never read it as a name.
        params.malformed = true;
        return params;
      }
      i += 1; // closing quote
      const next = value.indexOf(';', i);
      const stop = next === -1 ? value.length : next;
      if (value.slice(i, stop).trim() !== '') {
        // Only whitespace may sit between a closing quote and the next parameter.
        params.malformed = true;
        return params;
      }
      i = stop;
    } else {
      const next = value.indexOf(';', i);
      const stop = next === -1 ? value.length : next;
      paramValue = value.slice(i, stop).trim();
      i = stop;
    }
    if (name && !params.has(name)) params.set(name, paramValue);
  }
  return params;
}

/** Content-Disposition value from a part header block preserved as latin1. */
export function contentDispositionFromPartHeaders(headersLatin1) {
  if (typeof headersLatin1 !== 'string') return null;
  const match = /^content-disposition\s*:\s*([^\r\n]*)/im.exec(headersLatin1);
  return match ? match[1].trim() : null;
}

/**
 * Remove this attempt's staging directory only: concurrent attempts share `attempts/`.
 * A failure is logged and does not mask the error being reported to the caller.
 */
export async function cleanupAttempt(stagingRoot, attemptId) {
  try {
    await rm(join(stagingRoot, 'attempts', attemptId), { recursive: true, force: true });
  } catch (err) {
    console.warn(`[pipelines] could not remove attachment staging attempt=${attemptId} code=${err?.code ?? 'unknown'}`);
  }
}

function multipartBoundary(contentType) {
  const match = /;\s*boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) return null;
  const value = (match[1] ?? match[2] ?? '').trim();
  return value || null;
}

/**
 * Busboy silently skips parts that lack Content-Disposition, or whose disposition is not
 * a parseable `form-data` one. Detect missing headers while streaming and report every
 * part header block seen, so the caller can compare it with the parts busboy emitted and
 * a malformed part cannot be ignored alongside valid ones.
 */
export function createMissingDispositionGuard(boundary, onMissing, onPart = () => {}) {
  const open = Buffer.from(`--${boundary}\r\n`);
  const next = Buffer.from(`\r\n--${boundary}\r\n`);
  const close = Buffer.from(`\r\n--${boundary}--`);
  const headerEnd = Buffer.from('\r\n\r\n');
  let pending = Buffer.alloc(0);
  let phase = 'seek'; // seek | headers | body
  let reported = false;

  const report = () => {
    if (!reported) {
      reported = true;
      onMissing();
    }
  };

  const consumeHeaders = () => {
    const end = pending.indexOf(headerEnd);
    if (end === -1) {
      // Bound header accumulation; oversized headers are a framing error.
      if (pending.length > 16 * 1024) report();
      return false;
    }
    const headers = pending.subarray(0, end).toString('latin1');
    pending = pending.subarray(end + headerEnd.length);
    onPart(headers);
    if (!/^content-disposition\s*:/im.test(headers)) report();
    phase = 'body';
    return true;
  };

  return new Transform({
    transform(chunk, _enc, cb) {
      if (!reported) {
        pending = Buffer.concat([pending, chunk]);
        let progress = true;
        while (progress && !reported) {
          progress = false;
          if (phase === 'seek') {
            const at = pending.indexOf(open);
            if (at === -1) {
              // Keep a short overlap so a split boundary still matches.
              if (pending.length > open.length) {
                pending = pending.subarray(pending.length - open.length + 1);
              }
              break;
            }
            pending = pending.subarray(at + open.length);
            phase = 'headers';
            progress = true;
          } else if (phase === 'headers') {
            progress = consumeHeaders();
          } else {
            const nextAt = pending.indexOf(next);
            const closeAt = pending.indexOf(close);
            if (closeAt !== -1 && (nextAt === -1 || closeAt <= nextAt)) {
              pending = Buffer.alloc(0);
              phase = 'seek';
              reported = true; // closing boundary — stop inspecting
              break;
            }
            if (nextAt === -1) {
              if (pending.length > next.length) {
                pending = pending.subarray(pending.length - next.length + 1);
              }
              break;
            }
            pending = pending.subarray(nextAt + next.length);
            phase = 'headers';
            progress = true;
          }
        }
      }
      cb(null, chunk);
    },
  });
}

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {{ stagingRoot: string, attemptId?: string, createFileWriteStream?: (path: string) => import('node:fs').WriteStream }} options
 */
export async function parsePipelineStartMultipart(req, {
  stagingRoot,
  attemptId = randomUUID(),
  createFileWriteStream = (path) => createWriteStream(path, { flags: 'wx', mode: 0o600 }),
} = {}) {
  if (typeof stagingRoot !== 'string' || !stagingRoot.trim()) {
    throw problem(500, 'Attachment staging is not configured.');
  }

  const contentType = req.headers?.['content-type'];
  if (typeof contentType !== 'string' || !/multipart\/form-data/i.test(contentType)) {
    throw fieldProblem(400, 'content-type', 'multipart/form-data is required');
  }

  const boundary = multipartBoundary(contentType);
  if (!boundary) {
    throw fieldProblem(400, 'content-type', 'multipart boundary is required');
  }

  const declared = req.headers?.['content-length'];
  if (declared !== undefined && declared !== null && declared !== '') {
    const length = Number(declared);
    if (!Number.isInteger(length) || length < 0) {
      throw fieldProblem(400, 'content-length', 'must be a non-negative integer');
    }
    if (length > MULTIPART_TOTAL_MAX_BYTES) {
      throw fieldProblem(413, 'content-length', 'multipart request exceeds the size limit');
    }
  }

  // Exclusive attempt directory: never reuse or overwrite another attempt's staging.
  const attemptsRoot = join(stagingRoot, 'attempts');
  const stagingDir = join(attemptsRoot, attemptId);
  try {
    await mkdir(attemptsRoot, { recursive: true, mode: 0o700 });
    await mkdir(stagingDir, { mode: 0o700 });
  } catch (err) {
    // EEXIST means another attempt already owns this id — leave that directory alone.
    console.warn(`[pipelines] could not create attachment staging attempt=${attemptId} code=${err?.code ?? 'unknown'}`);
    throw problem(500, 'Failed to create attachment staging directory.');
  }

  let runRaw = null;
  const filesByIndex = [];
  let fileIndex = 0;
  let aggregateBytes = 0;
  let wireBytes = 0;
  let framedParts = 0;
  let emittedParts = 0;
  let fatal = null;
  // Filenames taken from wire Content-Disposition before busboy's lossy UTF-8 decode.
  const submittedFilenames = [];

  const markFatal = (err) => {
    if (!fatal) fatal = err;
  };

  const noteWireBytes = (n) => {
    wireBytes += n;
    if (wireBytes > MULTIPART_TOTAL_MAX_BYTES) {
      markFatal(fieldProblem(413, 'content-length', 'multipart request exceeds the size limit'));
    }
  };

  try {
    await new Promise((resolve, reject) => {
      let bb;
      try {
        bb = busboy({
          headers: req.headers,
          preservePath: true,
          defParamCharset: 'utf8',
          limits: {
            files: ATTACHMENT_MAX_COUNT + 1,
            fileSize: ATTACHMENT_MAX_BYTES + 1,
            fieldSize: RUN_JSON_MAX_BYTES + 1,
            fields: 8,
            parts: ATTACHMENT_MAX_COUNT + 8,
          },
        });
      } catch {
        reject(fieldProblem(400, 'content-type', 'malformed multipart framing'));
        return;
      }

      const pending = [];
      const sources = [];
      // Forward multipart bytes to busboy until it finishes; keep counting every wire byte,
      // including framing and any epilogue after the closing boundary.
      let forwardToBusboy = true;

      bb.on('field', (name, value, info) => {
        emittedParts += 1;
        // Every framed part has one queue entry; keep fields and files aligned in wire order.
        submittedFilenames.shift();
        if (fatal) return;
        if (name === 'run') {
          if (runRaw !== null) {
            markFatal(fieldProblem(400, 'run', 'duplicate run field'));
            return;
          }
          const size = Buffer.byteLength(value, 'utf8');
          if (info?.valueTruncated || size > RUN_JSON_MAX_BYTES) {
            markFatal(fieldProblem(413, 'run', 'run JSON exceeds the 512 KB limit'));
            return;
          }
          runRaw = value;
          return;
        }
        if (name === 'files') {
          markFatal(fieldProblem(400, `files[${fileIndex}]`, 'file part must include a filename'));
          return;
        }
        markFatal(fieldProblem(400, safeUnexpectedFieldName(name), 'unexpected multipart field'));
      });

      bb.on('file', (name, stream, info) => {
        emittedParts += 1;
        // Consume the matching wire disposition even when this part is rejected.
        const fromWire = submittedFilenames.shift();
        if (fatal) {
          stream.resume();
          return;
        }
        if (name !== 'files') {
          stream.resume();
          markFatal(fieldProblem(400, 'files', 'unexpected multipart file field'));
          return;
        }

        const index = fileIndex++;
        const field = `files[${index}]`;
        if (fromWire?.error) {
          stream.resume();
          markFatal(fieldProblem(400, field, fromWire.error));
          return;
        }
        if (typeof fromWire?.filename !== 'string') {
          // Busboy saw a filename the wire reader did not: never fall back to its lossy decode.
          stream.resume();
          markFatal(fieldProblem(400, field, 'filename could not be read'));
          return;
        }
        const submitted = fromWire.filename;

        if (!submitted) {
          stream.resume();
          markFatal(fieldProblem(400, field, 'file part must include a filename'));
          return;
        }
        if (!isSafeAttachmentName(submitted)) {
          stream.resume();
          markFatal(fieldProblem(400, field, 'filename is not a safe basename'));
          return;
        }
        if (index >= ATTACHMENT_MAX_COUNT) {
          stream.resume();
          markFatal(fieldProblem(413, 'files', `at most ${ATTACHMENT_MAX_COUNT} files`));
          return;
        }

        const stagingPath = join(stagingDir, `${String(index).padStart(2, '0')}-${randomUUID()}`);
        const hash = createHash('sha256');
        let sizeBytes = 0;
        let limitError = null;
        // Limits are checked before a chunk is written; past a limit the rest is drained unwritten.
        const meter = new Transform({
          transform(chunk, _enc, cb) {
            if (limitError) { cb(); return; }
            sizeBytes += chunk.length;
            aggregateBytes += chunk.length;
            if (sizeBytes > ATTACHMENT_MAX_BYTES) {
              limitError = fieldProblem(413, field, 'file exceeds the 20 MiB limit');
            } else if (aggregateBytes > ATTACHMENT_MAX_TOTAL_BYTES) {
              limitError = fieldProblem(413, 'files', 'aggregate attachment size exceeds the 100 MiB limit');
            }
            if (limitError) { cb(); return; }
            hash.update(chunk);
            cb(null, chunk);
          },
        });
        sources.push(stream);
        // pipeline() owns every stream's errors, so a failed open or write rejects here instead of
        // surfacing as an unhandled 'error' event.
        const work = pipeline(stream, meter, createFileWriteStream(stagingPath)).then(() => {
          if (info.truncated || limitError) {
            throw limitError || fieldProblem(413, field, 'file exceeds the 20 MiB limit');
          }
          filesByIndex[index] = {
            name: submitted,
            sizeBytes,
            digest: hash.digest('hex'),
            stagingPath,
          };
        }).catch((err) => {
          // Record the failure as the attempt's fatal error instead of rejecting: this promise
          // may otherwise sit without a handler until busboy finishes, and an unhandled
          // rejection stops the server.
          if (err?.status) { markFatal(err); return; }
          if (fatal) return;
          console.warn(`[pipelines] staging attachment failed field=${field} code=${err?.code ?? 'unknown'}`);
          markFatal(problem(500, 'Failed to stage attachment bytes.', [{ field, message: 'storage failure' }]));
        });
        pending.push(work);
      });

      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        if (err) markFatal(err);
        if (fatal) {
          // Stop every file still streaming, then wait until each has closed its staged file so
          // the caller's cleanup removes everything this attempt wrote.
          for (const source of sources) source.destroy();
          Promise.allSettled(pending).then(() => reject(fatal));
        } else {
          resolve();
        }
      };

      bb.on('error', (err) => {
        settle(fieldProblem(400, 'content-type', err?.message || 'malformed multipart framing'));
      });
      bb.on('partsLimit', () => settle(fieldProblem(413, 'files', 'too many multipart parts')));
      bb.on('filesLimit', () => settle(fieldProblem(413, 'files', `at most ${ATTACHMENT_MAX_COUNT} files`)));
      bb.on('fieldsLimit', () => settle(fieldProblem(400, 'run', 'too many multipart fields')));

      let endResolve = () => {};
      const requestEnded = new Promise((resolve) => {
        endResolve = resolve;
        if (req.readableEnded) resolve();
      });

      // Busboy reads from this side channel; the request listener meters every wire byte,
      // including framing and any epilogue after the closing boundary.
      const toBusboy = new PassThrough();
      const dispositionGuard = createMissingDispositionGuard(boundary, () => {
        markFatal(fieldProblem(400, 'content-type', 'malformed multipart framing'));
      }, (headers) => {
        framedParts += 1;
        const disposition = contentDispositionFromPartHeaders(headers);
        // One entry per framed part (null for a part without a filename), consumed in order
        // by busboy's field and file events.
        submittedFilenames.push(disposition ? rawMultipartFilename(disposition) : null);
      });

      bb.on('finish', () => {
        if (framedParts !== emittedParts) {
          // A part busboy skipped (for example `Content-Disposition: attachment`) is malformed.
          markFatal(fieldProblem(400, 'content-type', 'malformed multipart framing'));
        }
        forwardToBusboy = false;
        toBusboy.unpipe(dispositionGuard);
        dispositionGuard.unpipe(bb);
        toBusboy.resume();
        dispositionGuard.resume();
        if (typeof req.resume === 'function') req.resume();
        Promise.all([Promise.all(pending), requestEnded])
          .then(() => settle(fatal))
          .catch(err => settle(err));
      });

      req.on('data', (chunk) => {
        noteWireBytes(chunk.length);
        if (!forwardToBusboy) return;
        if (fatal) {
          // Stop feeding busboy (do not destroy open file streams — that can prevent
          // busboy 'finish') and keep draining the request so wire metering reaches EOF.
          forwardToBusboy = false;
          toBusboy.end();
          if (typeof req.resume === 'function') req.resume();
          return;
        }
        if (!toBusboy.write(chunk)) {
          req.pause();
          toBusboy.once('drain', () => req.resume());
        }
      });
      req.on('end', () => {
        if (forwardToBusboy) toBusboy.end();
        endResolve();
      });
      // Destroy/abort paths still need to unblock the finish waiter.
      req.on('close', () => endResolve());

      req.on('aborted', () => settle(problem(400, 'Request aborted before multipart parsing finished.')));
      req.on('error', (err) => settle(Object.assign(
        problem(400, err?.message || 'Request stream failed.'),
        { cause: err },
      )));
      toBusboy.on('error', (err) => settle(Object.assign(
        problem(400, err?.message || 'Request stream failed.'),
        { cause: err },
      )));
      dispositionGuard.on('error', (err) => settle(Object.assign(
        problem(400, err?.message || 'Request stream failed.'),
        { cause: err },
      )));

      toBusboy.pipe(dispositionGuard).pipe(bb);
      if (typeof req.resume === 'function') req.resume();
    });
  } catch (err) {
    await cleanupAttempt(stagingRoot, attemptId);
    if (err?.status) throw err;
    throw Object.assign(problem(400, err?.message || 'multipart parse failed'), { cause: err });
  }

  if (fatal) {
    await cleanupAttempt(stagingRoot, attemptId);
    throw fatal;
  }
  if (runRaw === null) {
    await cleanupAttempt(stagingRoot, attemptId);
    throw fieldProblem(400, 'run', 'run JSON field is required');
  }
  if (filesByIndex.length === 0 || filesByIndex.some(f => !f)) {
    await cleanupAttempt(stagingRoot, attemptId);
    throw fieldProblem(400, 'files', filesByIndex.length === 0 ? 'at least one file is required' : 'incomplete file batch');
  }

  let run;
  try {
    run = JSON.parse(runRaw);
  } catch {
    await cleanupAttempt(stagingRoot, attemptId);
    throw fieldProblem(400, 'run', 'run field must be valid JSON');
  }
  if (run === null || typeof run !== 'object' || Array.isArray(run)) {
    await cleanupAttempt(stagingRoot, attemptId);
    throw fieldProblem(400, 'run', 'run field must be a JSON object');
  }

  return { run, files: filesByIndex, stagingDir, attemptId };
}
