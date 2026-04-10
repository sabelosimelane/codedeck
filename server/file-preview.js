import fs from 'fs/promises';

export const MAX_PREVIEW_BYTES = 262144;

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
        truncated: stat.size > maxBytes,
        size: stat.size,
        content: null,
      };
    }

    return {
      kind: 'text',
      truncated: bytesRead > maxBytes,
      size: stat.size,
      content: previewSlice.toString('utf8'),
    };
  } finally {
    await handle.close();
  }
}
