import fs from 'fs/promises';
import path from 'path';

export const MAX_PREVIEW_BYTES = 262144;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx']);
const MERMAID_EXTENSIONS = new Set(['.mmd', '.mermaid']);

function isBinaryBuffer(buffer) {
  for (const byte of buffer) {
    if (byte === 0) return true;
  }
  return false;
}

async function readFilePreviewLocal(filePath, { maxBytes = MAX_PREVIEW_BYTES } = {}) {
  const stat = await fs.stat(filePath);

  if (!stat.isFile()) {
    throw new Error('not a file');
  }

  const handle = await fs.open(filePath, 'r');

  try {
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
    const previewSlice = buffer.subarray(0, Math.min(bytesRead, maxBytes));

    if (isBinaryBuffer(previewSlice)) {
      return {
        kind: 'binary',
        format: 'binary',
        truncated: stat.size > maxBytes,
        size: stat.size,
        content: null,
      };
    }

    const extension = path.extname(filePath).toLowerCase();

    let format = 'text';
    if (MARKDOWN_EXTENSIONS.has(extension)) {
      format = 'markdown';
    } else if (MERMAID_EXTENSIONS.has(extension)) {
      format = 'mermaid';
    }

    return {
      kind: 'text',
      format,
      truncated: bytesRead > maxBytes,
      size: stat.size,
      content: previewSlice.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}

async function readFilePreviewRemote(runner, filePath, { maxBytes = MAX_PREVIEW_BYTES } = {}) {
  // Check if it's a file
  try {
    await runner.run('test', ['-f', filePath]);
  } catch {
    throw new Error('not a file');
  }

  // Get file size
  let size = 0;
  try {
    const { stdout } = await runner.run('wc', ['-c', filePath]);
    // wc -c outputs "   123 /path/to/file"
    const match = stdout.trim().match(/^(\d+)/);
    if (match) {
      size = parseInt(match[1], 10);
    }
  } catch {
    // If wc fails, size is 0
  }

  // Read contents up to maxBytes + 1
  const { stdout } = await runner.run('head', ['-c', String(maxBytes + 1), filePath]);
  
  // Actually, runner.run uses utf8 encoding by default. If the file is binary,
  // Node's execFile tries to decode it as utf8 which might replace invalid chars with \uFFFD.
  // But we just need to see if there are null bytes. \u0000 is preserved in utf8.
  const isBinary = stdout.indexOf('\0') !== -1;
  const bytesRead = Buffer.byteLength(stdout, 'utf8');

  if (isBinary) {
    return {
      kind: 'binary',
      format: 'binary',
      truncated: size > maxBytes,
      size,
      content: null,
    };
  }

  const extension = path.extname(filePath).toLowerCase();

  let format = 'text';
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    format = 'markdown';
  } else if (MERMAID_EXTENSIONS.has(extension)) {
    format = 'mermaid';
  }

  // Buffer.byteLength counts bytes, so we truncate string if it's longer than maxBytes
  const previewSlice = Buffer.from(stdout, 'utf8').subarray(0, Math.min(bytesRead, maxBytes));

  return {
    kind: 'text',
    format,
    truncated: bytesRead > maxBytes || size > maxBytes,
    size,
    content: previewSlice.toString('utf8'),
  };
}

export async function readFilePreview(runner, filePath, opts = {}) {
  if (runner.kind === 'local') {
    return readFilePreviewLocal(filePath, opts);
  }
  return readFilePreviewRemote(runner, filePath, opts);
}
