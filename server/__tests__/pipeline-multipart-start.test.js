import { afterEach, describe, expect, it } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_MAX_COUNT,
  ATTACHMENT_MAX_TOTAL_BYTES,
} from '../pipelines/attachments.js';
import { parsePipelineStartMultipart, rawMultipartFilename } from '../pipelines/multipart-start.js';

const RUN_JSON_MAX = 512 * 1024;
const MULTIPART_TOTAL_MAX = ATTACHMENT_MAX_TOTAL_BYTES + (1024 * 1024);

const stagingRoots = [];

afterEach(async () => {
  await Promise.all(stagingRoots.splice(0).map(dir => rm(dir, { recursive: true, force: true })));
});

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function multipartBody(parts, boundary = '----CodedeckBoundary7MA4YWxk') {
  const chunks = [];
  for (const part of parts) {
    chunks.push(`--${boundary}\r\n`);
    if (part.filename !== undefined) {
      chunks.push(`Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\n`);
      chunks.push(`Content-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`);
      chunks.push(part.body);
      chunks.push('\r\n');
    } else {
      chunks.push(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`);
      chunks.push(part.body);
      chunks.push('\r\n');
    }
  }
  chunks.push(`--${boundary}--\r\n`);
  return Buffer.concat(chunks.map(c => (typeof c === 'string' ? Buffer.from(c) : c)));
}

async function parse(parts, { boundary = '----CodedeckBoundary7MA4YWxk', headers, stagingRoot, epilogue } = {}) {
  const form = multipartBody(parts, boundary);
  const root = stagingRoot ?? await mkdtemp(join(tmpdir(), 'cd-attach-'));
  if (!stagingRoots.includes(root)) stagingRoots.push(root);
  const req = Readable.from(epilogue ? [form, epilogue] : [form]);
  req.headers = {
    'content-type': `multipart/form-data; boundary=${boundary}`,
    'content-length': String(form.length + (epilogue?.length ?? 0)),
    ...headers,
  };
  return parsePipelineStartMultipart(req, { stagingRoot: root, attemptId: randomUUID() });
}

const runJson = JSON.stringify({
  requestId: 'attach-1',
  workflowId: 'a2d0b1c2-3456-4789-8abc-def012345678',
  project: 'Demo',
  input: 'hello',
});

describe('parsePipelineStartMultipart', () => {
  it('parses one run JSON field and ordered file parts into staged digests', async () => {
    const a = Buffer.from('alpha');
    const b = Buffer.from('beta');
    const result = await parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a.txt', body: a },
      { name: 'files', filename: 'b.txt', body: b },
    ]);
    expect(result.run).toEqual(JSON.parse(runJson));
    expect(result.files).toEqual([
      expect.objectContaining({ name: 'a.txt', sizeBytes: 5, digest: sha256(a) }),
      expect.objectContaining({ name: 'b.txt', sizeBytes: 4, digest: sha256(b) }),
    ]);
    expect(await readFile(result.files[0].stagingPath)).toEqual(a);
    expect(await readFile(result.files[1].stagingPath)).toEqual(b);
    expect(result.stagingDir).toMatch(/attempts/);
  });

  it('accepts a zero-byte file', async () => {
    const result = await parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'empty.bin', body: Buffer.alloc(0) },
    ]);
    expect(result.files[0]).toMatchObject({ name: 'empty.bin', sizeBytes: 0, digest: sha256(Buffer.alloc(0)) });
    expect((await readFile(result.files[0].stagingPath)).length).toBe(0);
  });

  it('preserves a valid UTF-8 filename containing a literal U+FFFD character', async () => {
    const name = 'notes-\uFFFD.txt';
    const contents = Buffer.from('reference notes');
    const result = await parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: name, body: contents },
    ]);
    expect(result.files[0]).toMatchObject({
      name,
      sizeBytes: contents.length,
      digest: sha256(contents),
    });
  });

  it('rejects an invalid UTF-8 byte sequence in the submitted filename', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const boundary = '----CodedeckBoundaryBadUtf8';
    // file.<0xFF>txt — 0xFF is not valid UTF-8; busboy would lossily replace it with U+FFFD.
    const badName = Buffer.from([0x66, 0x69, 0x6c, 0x65, 0x2e, 0xff, 0x74, 0x78, 0x74]);
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="run"\r\n\r\n${runJson}\r\n`),
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="`),
      badName,
      Buffer.from('"\r\nContent-Type: application/octet-stream\r\n\r\nx\r\n'),
      Buffer.from(`--${boundary}--\r\n`),
    ]);
    const req = Readable.from([body]);
    req.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root, attemptId: randomUUID() }))
      .rejects.toMatchObject({
        status: 400,
        errors: [expect.objectContaining({ field: 'files[0]', message: 'invalid filename encoding' })],
      });
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it('uses the submitted filename before any basename conversion', async () => {
    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: '../etc/passwd', body: Buffer.from('x') },
    ])).rejects.toMatchObject({ status: 400, errors: [expect.objectContaining({ field: 'files[0]' })] });
  });

  it.each([
    ['a leading Unicode format character', '\uFEFFnotes.txt'],
    ['a backslash separator before an ordinary character', String.raw`folder\notes.txt`],
  ])('rejects filenames with %s instead of silently changing the name', async (_label, filename) => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename, body: Buffer.from('x') },
    ], { stagingRoot: root })).rejects.toMatchObject({
      status: 400,
      errors: [expect.objectContaining({ field: 'files[0]' })],
    });
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it.each([
    ['missing run', [{ name: 'files', filename: 'a.txt', body: Buffer.from('x') }], 'run'],
    ['duplicate run', [{ name: 'run', body: runJson }, { name: 'run', body: runJson }, { name: 'files', filename: 'a.txt', body: Buffer.from('x') }], 'run'],
    ['malformed run JSON', [{ name: 'run', body: '{no' }, { name: 'files', filename: 'a.txt', body: Buffer.from('x') }], 'run'],
    ['unexpected field', [{ name: 'run', body: runJson }, { name: 'extra', body: '1' }, { name: 'files', filename: 'a.txt', body: Buffer.from('x') }], 'extra'],
    ['file field without filename', [{ name: 'run', body: runJson }, { name: 'files', body: 'x' }], 'files[0]'],
    ['empty file batch', [{ name: 'run', body: runJson }], 'files'],
  ])('rejects %s with 400', async (_label, parts, field) => {
    await expect(parse(parts)).rejects.toMatchObject({
      status: 400,
      errors: [expect.objectContaining({ field })],
    });
  });

  it('rejects 21 files with 413 and cleans staging', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const parts = [{ name: 'run', body: runJson }];
    for (let i = 0; i < ATTACHMENT_MAX_COUNT + 1; i++) {
      parts.push({ name: 'files', filename: `f${i}.txt`, body: Buffer.from(String(i)) });
    }
    await expect(parse(parts, { stagingRoot: root })).rejects.toMatchObject({ status: 413 });
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it('accepts exactly 20 files', async () => {
    const parts = [{ name: 'run', body: runJson }];
    for (let i = 0; i < ATTACHMENT_MAX_COUNT; i++) {
      parts.push({ name: 'files', filename: `f${i}.txt`, body: Buffer.from(String(i)) });
    }
    const result = await parse(parts);
    expect(result.files).toHaveLength(20);
  });

  it('rejects one byte over the per-file limit while accepting the exact limit', async () => {
    const exact = Buffer.alloc(ATTACHMENT_MAX_BYTES, 1);
    const ok = await parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'exact.bin', body: exact },
    ]);
    expect(ok.files[0].sizeBytes).toBe(ATTACHMENT_MAX_BYTES);

    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'over.bin', body: Buffer.alloc(ATTACHMENT_MAX_BYTES + 1, 1) },
    ])).rejects.toMatchObject({ status: 413, errors: [expect.objectContaining({ field: 'files[0]' })] });
  });

  it('accepts the aggregate byte limit and rejects one over with individually valid files', async () => {
    const fullFile = Buffer.alloc(ATTACHMENT_MAX_BYTES, 1);
    const fullBatch = [
      { name: 'run', body: runJson },
      ...Array.from({ length: ATTACHMENT_MAX_TOTAL_BYTES / ATTACHMENT_MAX_BYTES }, (_, index) => ({
        name: 'files', filename: `${index}.bin`, body: fullFile,
      })),
    ];
    const exact = await parse(fullBatch);
    expect(exact.files.reduce((sum, file) => sum + file.sizeBytes, 0)).toBe(ATTACHMENT_MAX_TOTAL_BYTES);
    await expect(parse([
      ...fullBatch,
      { name: 'files', filename: 'one-more.bin', body: Buffer.from('x') },
    ])).rejects.toMatchObject({
      status: 413,
      errors: [{ field: 'files', message: expect.stringMatching(/aggregate/) }],
    });
  });

  it('counts every wire byte in a chunked request even after the closing boundary', async () => {
    const parts = [
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a.txt', body: Buffer.from('x') },
    ];
    const headers = { 'content-length': undefined, 'transfer-encoding': 'chunked' };
    const exact = Buffer.alloc(MULTIPART_TOTAL_MAX - multipartBody(parts).length, 1);
    await expect(parse(parts, { headers, epilogue: exact })).resolves.toMatchObject({
      files: [expect.objectContaining({ name: 'a.txt', sizeBytes: 1 })],
    });
    await expect(parse(parts, { headers, epilogue: Buffer.alloc(exact.length + 1, 1) }))
      .rejects.toMatchObject({ status: 413 });
  });

  it('rejects a part without a field name even when the required parts are present', async () => {
    const boundary = '----UnnamedPart';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; filename="unexpected.txt"\r\n\r\nx\r\n`),
      multipartBody([
        { name: 'run', body: runJson },
        { name: 'files', filename: 'valid.txt', body: Buffer.from('a') },
      ], boundary),
    ]);
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const req = Readable.from(body);
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('rejects a part without Content-Disposition even when the required parts are present', async () => {
    const boundary = '----MissingDisposition';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Type: text/plain\r\n\r\nunexpected\r\n`),
      multipartBody([
        { name: 'run', body: runJson },
        { name: 'files', filename: 'valid.txt', body: Buffer.from('a') },
      ], boundary),
    ]);
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const req = Readable.from([body]);
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root }))
      .rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it.each([
    ['a non-form-data disposition type', 'Content-Disposition: attachment; name="files"; filename="skipped.txt"'],
    ['an unparseable disposition', 'Content-Disposition: ;;;'],
  ])('rejects a part with %s that busboy would otherwise skip', async (_label, header) => {
    const boundary = '----SkippedDisposition';
    const body = Buffer.concat([
      Buffer.from(`--${boundary}\r\n${header}\r\n\r\nunexpected\r\n`),
      multipartBody([
        { name: 'run', body: runJson },
        { name: 'files', filename: 'valid.txt', body: Buffer.from('a') },
      ], boundary),
    ]);
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const req = Readable.from([body]);
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root }))
      .rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it('rejects a part without Content-Disposition when its headers arrive one byte at a time', async () => {
    const boundary = '----SplitDisposition';
    const body = Buffer.concat([
      multipartBody([
        { name: 'run', body: runJson },
        { name: 'files', filename: 'valid.txt', body: Buffer.from('a') },
      ], boundary).subarray(0, -(`--${boundary}--\r\n`.length)),
      Buffer.from(`--${boundary}\r\nContent-Type: text/plain\r\n\r\nunexpected\r\n--${boundary}--\r\n`),
    ]);
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const req = Readable.from([...body].map(byte => Buffer.from([byte])));
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root }))
      .rejects.toMatchObject({ status: 400 });
  });

  it('refuses to reuse an existing attempt directory and preserves its contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const attemptId = randomUUID();
    const directory = join(root, 'attempts', attemptId);
    await mkdir(directory, { recursive: true });
    const sentinel = join(directory, 'existing');
    await writeFile(sentinel, 'existing attempt bytes');
    const boundary = '----ExistingAttempt';
    const req = Readable.from([multipartBody([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'valid.txt', body: Buffer.from('a') },
    ], boundary)]);
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root, attemptId }))
      .rejects.toMatchObject({ status: 500 });
    expect(await readdir(directory)).toEqual(['existing']);
    expect(await readFile(sentinel, 'utf8')).toBe('existing attempt bytes');
  });

  it('rejects a run JSON part over the 512 KB bound', async () => {
    const huge = JSON.stringify({ ...JSON.parse(runJson), input: 'x'.repeat(RUN_JSON_MAX) });
    expect(Buffer.byteLength(huge)).toBeGreaterThan(RUN_JSON_MAX);
    await expect(parse([
      { name: 'run', body: huge },
      { name: 'files', filename: 'a.txt', body: Buffer.from('x') },
    ])).rejects.toMatchObject({ status: 413, errors: [expect.objectContaining({ field: 'run' })] });
  });

  it('rejects names that are too long or contain controls', async () => {
    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a'.repeat(256), body: Buffer.from('x') },
    ])).rejects.toMatchObject({ status: 400, errors: [expect.objectContaining({ field: 'files[0]' })] });

    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a\nb.txt', body: Buffer.from('x') },
    ])).rejects.toMatchObject({ status: 400 });
  });

  it('rejects invalid filename* encodings before treating them as basenames', () => {
    expect(rawMultipartFilename(`form-data; name="files"; filename*=UTF-8''file.%zz.txt`))
      .toEqual({ error: 'invalid filename encoding' });
    expect(rawMultipartFilename(`form-data; name="files"; filename="ok.txt"`))
      .toEqual({ filename: 'ok.txt' });
    // Wire latin1: EF BF BD is valid UTF-8 for U+FFFD; lone FD is not.
    expect(rawMultipartFilename('form-data; name="files"; filename="notes-\xEF\xBF\xBD.txt"'))
      .toEqual({ filename: 'notes-\uFFFD.txt' });
    expect(rawMultipartFilename('form-data; name="files"; filename="file.\xFFtxt"'))
      .toEqual({ error: 'invalid filename encoding' });
    expect(rawMultipartFilename(`form-data; name="files"; filename*=UTF-8''file.%FFtxt`))
      .toEqual({ error: 'invalid filename encoding' });
  });

  it('reads filename only as its own disposition parameter, not inside another one', () => {
    expect(rawMultipartFilename('form-data; name="run"; x-filename="evil.txt"')).toBeNull();
    expect(rawMultipartFilename('form-data; name="files"; x-filename="evil.txt"; filename="real.txt"'))
      .toEqual({ filename: 'real.txt' });
    expect(rawMultipartFilename('form-data; name="files"; FileName = "real.txt"'))
      .toEqual({ filename: 'real.txt' });
    expect(rawMultipartFilename('form-data; name="files"; x="a; filename=evil.txt"; filename="real.txt"'))
      .toEqual({ filename: 'real.txt' });
    expect(rawMultipartFilename('form-data; name="files"; filename="a\\"b.txt"'))
      .toEqual({ filename: 'a"b.txt' });
    expect(rawMultipartFilename('form-data; name="files"; filename=plain.txt'))
      .toEqual({ filename: 'plain.txt' });
  });

  it('rejects a quoted disposition value that is never closed or is followed by stray text', () => {
    expect(rawMultipartFilename('form-data; name="files"; filename="abc'))
      .toEqual({ error: 'malformed content disposition' });
    expect(rawMultipartFilename('form-data; name="files"; filename="abc.txt" junk'))
      .toEqual({ error: 'malformed content disposition' });
    expect(rawMultipartFilename('form-data; name="files"; filename="abc.txt" ; x=1'))
      .toEqual({ filename: 'abc.txt' });
  });

  it('rejects a file part whose quoted filename is never closed and stages nothing', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const boundary = '----CodedeckBoundaryUnclosed';
    const body = Buffer.from([
      `--${boundary}\r\nContent-Disposition: form-data; name="run"\r\n\r\n${runJson}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="abc\r\n`,
      'Content-Type: text/plain\r\n\r\nbytes\r\n',
      `--${boundary}--\r\n`,
    ].join(''));
    const req = Readable.from([body]);
    req.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root, attemptId: randomUUID() }))
      .rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it('rejects a run field whose disposition has stray text after a quoted value', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const boundary = '----CodedeckBoundaryStray';
    const body = Buffer.from([
      `--${boundary}\r\nContent-Disposition: form-data; name="run" junk\r\n\r\n${runJson}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\n`,
      'Content-Type: text/plain\r\n\r\nbytes\r\n',
      `--${boundary}--\r\n`,
    ].join(''));
    const req = Readable.from([body]);
    req.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    };
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root, attemptId: randomUUID() }))
      .rejects.toMatchObject({ status: 400 });
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it('keeps each file paired with its own name when another part carries a filename-like parameter', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const boundary = '----CodedeckBoundaryLookalike';
    const body = Buffer.from([
      `--${boundary}\r\nContent-Disposition: form-data; name="run"; x-filename="evil.txt"\r\n\r\n${runJson}\r\n`,
      `--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="real.txt"\r\n`,
      'Content-Type: text/plain\r\n\r\nreal\r\n',
      `--${boundary}--\r\n`,
    ].join(''));
    const req = Readable.from([body]);
    req.headers = {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    };
    const result = await parsePipelineStartMultipart(req, { stagingRoot: root, attemptId: randomUUID() });
    expect(result.files.map(f => f.name)).toEqual(['real.txt']);
  });

  it('cleans staging when the request aborts mid-stream', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const boundary = '----AbortBoundary';
    const prefix = multipartBody([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'big.bin', body: Buffer.alloc(64 * 1024, 7) },
    ], boundary).subarray(0, 300);
    const req = new Readable({
      read() {
        this.push(prefix);
        this.push(null);
        this.emit('aborted');
        this.destroy(Object.assign(new Error('aborted'), { code: 'ECONNRESET' }));
      },
    });
    req.headers = { 'content-type': `multipart/form-data; boundary=${boundary}` };
    req.complete = false;
    await expect(parsePipelineStartMultipart(req, { stagingRoot: root, attemptId: randomUUID() }))
      .rejects.toBeTruthy();
    expect(await readdir(join(root, 'attempts'))).toEqual([]);
  });

  it('reports 500 and cleans staging when the staging directory cannot be created', async () => {
    const blocker = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(blocker);
    // Point stagingRoot at a file path so mkdir of attempt dir fails.
    const filePath = join(blocker, 'not-a-dir');
    await writeFile(filePath, 'x');
    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a.txt', body: Buffer.from('x') },
    ], { stagingRoot: filePath })).rejects.toMatchObject({ status: 500 });
  });

  it('removes only its own attempt directory, leaving a concurrent attempt staged', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const sibling = join(root, 'attempts', 'other-attempt');
    await mkdir(sibling, { recursive: true });
    await writeFile(join(sibling, '00-staged'), 'other bytes');
    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a'.repeat(256), body: Buffer.from('x') },
    ], { stagingRoot: root })).rejects.toMatchObject({ status: 400 });
    expect(await readFile(join(sibling, '00-staged'), 'utf8')).toBe('other bytes');
    expect(await readdir(join(root, 'attempts'))).toEqual(['other-attempt']);
  });

  it('reports 500 without crashing when writing a staged file fails, and names no staging path', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const body = multipartBody([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a.txt', body: Buffer.from('x') },
    ]);
    const req = Readable.from(body);
    req.headers = { 'content-type': 'multipart/form-data; boundary=----CodedeckBoundary7MA4YWxk' };
    const createFileWriteStream = () => {
      const stream = new Writable({
        write(_chunk, _enc, cb) {
          cb(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
        },
      });
      return stream;
    };
    const err = await parsePipelineStartMultipart(req, { stagingRoot: root, createFileWriteStream }).catch(e => e);
    expect(err).toMatchObject({ status: 500, errors: [{ field: 'files[0]', message: 'storage failure' }] });
    expect(JSON.stringify(err.errors)).not.toContain(root);
  });

  it('raises no unhandled rejection when a staged write fails while later parts are still streaming', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cd-attach-'));
    stagingRoots.push(root);
    const body = multipartBody([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a.txt', body: Buffer.from('x') },
      { name: 'files', filename: 'b.txt', body: Buffer.alloc(64 * 1024, 1) },
    ]);
    const split = body.indexOf('b.txt');
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const createFileWriteStream = () => new Writable({
      write(_chunk, _enc, cb) {
        cb(Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }));
      },
    });
    try {
      const req = Readable.from((async function* () {
        yield body.subarray(0, split);
        await new Promise(r => setTimeout(r, 100));
        yield body.subarray(split);
      })());
      req.headers = { 'content-type': 'multipart/form-data; boundary=----CodedeckBoundary7MA4YWxk' };
      const err = await parsePipelineStartMultipart(req, { stagingRoot: root, createFileWriteStream }).catch(e => e);
      await new Promise(r => setTimeout(r, 20));
      expect(err).toMatchObject({ status: 500, errors: [{ field: 'files[0]', message: 'storage failure' }] });
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('rejects a request whose declared content length exceeds the multipart total bound', async () => {
    await expect(parse([
      { name: 'run', body: runJson },
      { name: 'files', filename: 'a.txt', body: Buffer.from('x') },
    ], { headers: { 'content-length': String(MULTIPART_TOTAL_MAX + 1) } }))
      .rejects.toMatchObject({ status: 413 });
  });
});
