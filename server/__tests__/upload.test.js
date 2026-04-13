import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import { createServer } from 'http';
import fs from 'fs/promises';
import path from 'path';
import request from 'supertest';
import multer from 'multer';

const UPLOAD_DIR = '/tmp/codedeck-drops-test';
const UPLOAD_MAX_SIZE = 20 * 1024 * 1024;

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function createApp() {
  const app = express();

  const upload = multer({
    storage: multer.diskStorage({
      destination: async (_req, _file, cb) => {
        try {
          await fs.mkdir(UPLOAD_DIR, { recursive: true });
          cb(null, UPLOAD_DIR);
        } catch (err) {
          cb(err);
        }
      },
      filename: (_req, file, cb) => {
        const sanitized = sanitizeFilename(file.originalname);
        cb(null, `${Date.now()}-${sanitized}`);
      },
    }),
    limits: { fileSize: UPLOAD_MAX_SIZE },
  });

  app.post('/api/upload', (req, res) => {
    upload.single('file')(req, res, (err) => {
      if (err) {
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'File too large (max 20MB)' });
        }
        return res.status(500).json({ error: 'Failed to save file', detail: err.message });
      }
      if (!req.file) {
        return res.status(400).json({ error: 'No file provided' });
      }
      res.status(201).json({ path: req.file.path });
    });
  });

  return app;
}

describe('POST /api/upload', () => {
  let app;

  beforeAll(() => {
    app = createApp();
  });

  afterEach(async () => {
    // Clean up uploaded files
    try {
      const files = await fs.readdir(UPLOAD_DIR);
      await Promise.all(files.map(f => fs.unlink(path.join(UPLOAD_DIR, f))));
    } catch {
      // Directory may not exist yet
    }
  });

  afterAll(async () => {
    try {
      await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
    } catch {
      // Ignore
    }
  });

  it('uploads a valid file and returns 201 with path', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('hello world'), 'test.txt');

    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/^\/tmp\/codedeck-drops-test\/\d+-test\.txt$/);

    // Verify file was actually written
    const content = await fs.readFile(res.body.path, 'utf-8');
    expect(content).toBe('hello world');
  });

  it('uploads a binary file (image)', async () => {
    const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const res = await request(app)
      .post('/api/upload')
      .attach('file', pngHeader, 'screenshot.png');

    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/screenshot\.png$/);
  });

  it('returns 400 when no file is attached', async () => {
    const res = await request(app)
      .post('/api/upload')
      .send();

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'No file provided' });
  });

  it('returns 413 when file exceeds 20MB', async () => {
    const bigBuffer = Buffer.alloc(21 * 1024 * 1024, 'x');
    const res = await request(app)
      .post('/api/upload')
      .attach('file', bigBuffer, 'huge.bin');

    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'File too large (max 20MB)' });
  });

  it('sanitizes filenames — replaces unsafe characters with underscore', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('data'), 'my file (1) @#$.txt');

    expect(res.status).toBe(201);
    // Spaces, parens, @, #, $ should all become _
    expect(res.body.path).toMatch(/my_file__1_____.txt$/);
  });

  it('preserves safe filename characters', async () => {
    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('data'), 'valid-name_2024.tar.gz');

    expect(res.status).toBe(201);
    expect(res.body.path).toMatch(/valid-name_2024\.tar\.gz$/);
  });

  it('creates the upload directory on demand', async () => {
    // Remove the directory first
    try {
      await fs.rm(UPLOAD_DIR, { recursive: true, force: true });
    } catch {
      // May not exist
    }

    const res = await request(app)
      .post('/api/upload')
      .attach('file', Buffer.from('test'), 'auto-dir.txt');

    expect(res.status).toBe(201);

    // Directory should now exist
    const stat = await fs.stat(UPLOAD_DIR);
    expect(stat.isDirectory()).toBe(true);
  });
});

describe('sanitizeFilename', () => {
  it('keeps alphanumeric, dots, hyphens, underscores', () => {
    expect(sanitizeFilename('hello-world_v2.0.txt')).toBe('hello-world_v2.0.txt');
  });

  it('replaces spaces and special characters', () => {
    expect(sanitizeFilename('my file (copy).txt')).toBe('my_file__copy_.txt');
  });

  it('replaces unicode characters', () => {
    expect(sanitizeFilename('résumé.pdf')).toBe('r_sum_.pdf');
  });

  it('handles empty string', () => {
    expect(sanitizeFilename('')).toBe('');
  });
});
