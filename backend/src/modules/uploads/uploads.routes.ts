import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Router } from 'express';
import multer from 'multer';
import { authenticate, requireRole } from '../../middleware/auth.js';
import { AppError } from '../../utils/errors.js';
import { ok } from '../../utils/http.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const UPLOAD_DIR = path.resolve(here, '../../../uploads');
const MAX_BYTES = 5 * 1024 * 1024;

/**
 * Image uploads. Defences:
 *  - size cap (5 MB) and one file per request, enforced by multer while streaming;
 *  - type detected from the file's MAGIC BYTES, not the client-supplied MIME type or extension;
 *  - SVG is refused (it can carry script);
 *  - files are renamed to random UUIDs, so user input never reaches the filesystem path;
 *  - served with `X-Content-Type-Options: nosniff` (see app.ts).
 */
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_BYTES, files: 1 } });

function sniff(buf: Buffer): 'jpg' | 'png' | 'webp' | null {
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

export const uploadsRouter = Router();

uploadsRouter.post('/images', authenticate, requireRole('USER'), upload.single('image'), async (req, res) => {
  const file = req.file;
  if (!file) throw new AppError('VALIDATION_ERROR', 'Attach an image in the "image" field');
  const ext = sniff(file.buffer);
  if (!ext) throw new AppError('UNSUPPORTED_MEDIA_TYPE', 'Only JPEG, PNG and WebP images are allowed');
  await mkdir(UPLOAD_DIR, { recursive: true });
  const name = `${randomUUID()}.${ext}`;
  await writeFile(path.join(UPLOAD_DIR, name), file.buffer, { flag: 'wx' });
  ok(res, { url: `/uploads/${name}`, bytes: file.size }, undefined, 201);
});
