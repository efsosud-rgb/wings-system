import { describe, expect, it } from 'vitest';
import { buildServer } from './server.js';

describe('api', () => {
  it('answers the health check', async () => {
    const app = buildServer();
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'ok' });
    await app.close();
  });
});
