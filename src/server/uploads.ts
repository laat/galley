import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Hono } from 'hono';

/**
 * Images pasted into comments. They are stored in the data directory under the SHA-256 of
 * their bytes, and served from /uploads/<sha256>.<ext>, the only local image URLs that
 * rendered Markdown keeps.
 */

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

interface ImageType {
  ext: string;
  type: string;
}

const PNG: ImageType = { ext: 'png', type: 'image/png' };
const JPEG: ImageType = { ext: 'jpg', type: 'image/jpeg' };
const GIF: ImageType = { ext: 'gif', type: 'image/gif' };
const WEBP: ImageType = { ext: 'webp', type: 'image/webp' };
const BY_EXT = new Map([PNG, JPEG, GIF, WEBP].map((t) => [t.ext, t]));

/** An uploaded image's path, as the web UI writes it into Markdown. */
export const UPLOAD_PATH = /^\/uploads\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)$/;

/** The uploaded images a text refers to, each once. */
export function uploadsIn(text: string): string[] {
  return [...new Set(text.match(/\/uploads\/[0-9a-f]{64}\.(?:png|jpg|gif|webp)\b/g) ?? [])];
}

/**
 * What the bytes are, by their magic numbers. SVG is not among them: it can carry script,
 * and a browser opening it from this origin would run it.
 */
export function sniffImage(b: Uint8Array): ImageType | null {
  const ascii = (at: number, s: string) => Buffer.from(b.subarray(at, at + s.length)).toString('latin1') === s;
  if (ascii(0, '\x89PNG\r\n\x1a\n')) return PNG;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return JPEG;
  if (ascii(0, 'GIF87a') || ascii(0, 'GIF89a')) return GIF;
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return WEBP;
  return null;
}

/** The request body, or null once it is larger than `limit` bytes. */
async function readUpTo(req: Request, limit: number): Promise<Buffer | null> {
  if (!req.body) return Buffer.alloc(0);
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

/** POST /api/uploads (the raw bytes of one image) and GET /uploads/<sha256>.<ext>. */
export function uploads(dir: string): Hono {
  const app = new Hono();
  const refuse = (status: 413 | 415 | 422, message: string, headers?: Record<string, string>) => Response.json({ message, status: String(status) }, { status, headers });
  const tooBig = `Images can be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`;

  app.post('/api/uploads', async (c) => {
    const declared = (c.req.header('content-type') ?? '').split(';')[0].trim().toLowerCase();
    if (declared === 'image/svg+xml') return refuse(415, 'SVG images are not accepted: an SVG can carry script.');
    if (declared && declared !== 'application/octet-stream' && ![...BY_EXT.values()].some((t) => t.type === declared)) {
      return refuse(415, `Only PNG, JPEG, GIF and WebP images can be uploaded, not ${declared}.`);
    }
    // Node reads and drops a body that was never touched, so the connection can carry on.
    if (Number(c.req.header('content-length') ?? 0) > MAX_UPLOAD_BYTES) return refuse(413, tooBig);
    const bytes = await readUpTo(c.req.raw, MAX_UPLOAD_BYTES);
    // Half of a body is left on the connection, so it cannot be used again.
    if (!bytes) return refuse(413, tooBig, { connection: 'close' });
    if (!bytes.length) return refuse(422, 'The upload is empty.');
    const image = sniffImage(bytes);
    if (!image) return refuse(415, 'Only PNG, JPEG, GIF and WebP images can be uploaded, and this file is none of them.');

    const name = `${createHash('sha256').update(bytes).digest('hex')}.${image.ext}`;
    const file = join(dir, name);
    // Named by content, so a file already there holds these bytes. Renamed into place, so a
    // reader never sees half of one.
    if (!(await access(file).then(() => true, () => false))) {
      await mkdir(dir, { recursive: true });
      const tmp = `${file}.${randomUUID()}.tmp`;
      await writeFile(tmp, bytes);
      await rename(tmp, file);
    }
    const path = `/uploads/${name}`;
    return c.json({ path, url: new URL(path, c.req.url).href, content_type: image.type, size: bytes.length }, 201);
  });

  app.get('/uploads/:file', async (c, next) => {
    const file = c.req.param('file');
    // Anything else under /uploads is left to the web routes (an owner may be called "uploads").
    if (!UPLOAD_PATH.test(`/uploads/${file}`)) return next();
    const body = await readFile(join(dir, file)).catch(() => null);
    if (!body) return c.text('Not Found', 404);
    return c.body(body, 200, {
      'content-type': BY_EXT.get(file.slice(file.lastIndexOf('.') + 1))!.type,
      // The name is the content's hash, so it never changes.
      'cache-control': 'public, max-age=31536000, immutable',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
    });
  });

  return app;
}
