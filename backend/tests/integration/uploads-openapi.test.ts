import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { openApiSpec } from '../../src/docs/openapi.js';
import { useCleanDatabase } from './setup.js';
import { createUser } from '../helpers/fixtures.js';

const app = createApp();
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

describe('uploads', () => {
  useCleanDatabase();

  it('accepts a real PNG and rejects files whose bytes are not an image, whatever their name', async () => {
    const s = await createUser('SELLER');
    const ok = await request(app).post('/api/v1/uploads/images').set('Authorization', `Bearer ${s.token}`).attach('image', PNG, { filename: 'x.png', contentType: 'image/png' });
    expect(ok.status).toBe(201);
    expect(ok.body.data.url).toMatch(/^\/uploads\/[0-9a-f-]+\.png$/);
    const fake = await request(app)
      .post('/api/v1/uploads/images')
      .set('Authorization', `Bearer ${s.token}`)
      .attach('image', Buffer.from('<svg onload="alert(1)"/>'), { filename: 'evil.png', contentType: 'image/png' });
    expect(fake.status).toBe(415);
  });

  it('rejects files over 5 MB', async () => {
    const s = await createUser('SELLER');
    const big = Buffer.concat([PNG, Buffer.alloc(5 * 1024 * 1024 + 1)]);
    const res = await request(app).post('/api/v1/uploads/images').set('Authorization', `Bearer ${s.token}`).attach('image', big, { filename: 'big.png', contentType: 'image/png' });
    expect(res.status).toBe(413);
  });
});

describe('OpenAPI document', () => {
  it('only documents routes that exist', async () => {
    const missing: string[] = [];
    for (const [path, ops] of Object.entries(openApiSpec.paths)) {
      for (const method of Object.keys(ops)) {
        const url = `/api/v1${path.replace(/\{[^}]+\}/g, '1')}`;
        const res = await request(app)[method as 'get'](url);
        if (res.status === 404 && /^Route /.test(res.body?.error?.message ?? '')) missing.push(`${method.toUpperCase()} ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('serves request ids on every response, including errors', async () => {
    const res = await request(app).get('/api/v1/nope').set('X-Request-Id', 'demo-request-1234');
    expect(res.status).toBe(404);
    expect(res.headers['x-request-id']).toBe('demo-request-1234');
    expect(res.body.error.requestId).toBe('demo-request-1234');
  });
});
