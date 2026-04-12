import fs from 'fs/promises';
import path from 'path';

export const MAX_PREVIEW_BYTES = 262144;
const MARKDOWN_EXTENSIONS = new Set(['.md', '.markdown', '.mdown', '.mkd', '.mdx']);

function isBinaryBuffer(buffer) {
  for (const byte of buffer) {
    if (byte === 0) return true;
  }
  return false;
}

export async function readFilePreview(filePath, { maxBytes = MAX_PREVIEW_BYTES } = {}) {
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

    return {
      kind: 'text',
      format: MARKDOWN_EXTENSIONS.has(extension) ? 'markdown' : 'text',
      truncated: bytesRead > maxBytes,
      size: stat.size,
      content: previewSlice.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}
