import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// nginx drops the server-level add_header lines inside any location that has
// its own add_header. That is how index.html once went out with no security
// headers, so every such location must include the snippet again.
const dockerDir = resolve(import.meta.dirname, '../../../docker');
const conf = readFileSync(resolve(dockerDir, 'web-nginx.conf'), 'utf8');
const snippet = readFileSync(resolve(dockerDir, 'web-security-headers.conf'), 'utf8');
const dockerfile = readFileSync(resolve(dockerDir, 'web.Dockerfile'), 'utf8');
const INCLUDE = 'include /etc/nginx/snippets/security-headers.conf;';

describe('web nginx security headers', () => {
  it('lets only this system frame the pages', () => {
    expect(snippet).toContain(
      `add_header Content-Security-Policy "frame-ancestors 'self'" always;`,
    );
    expect(snippet).toContain('add_header X-Frame-Options "SAMEORIGIN" always;');
    expect(snippet).toContain('add_header X-Content-Type-Options "nosniff" always;');
  });

  it('sends them from every location that has its own add_header, and at server level', () => {
    const locations = [...conf.matchAll(/location[^{]*\{([^}]*)\}/g)].map((m) => m[1] ?? '');
    expect(locations.length).toBeGreaterThan(0);
    for (const body of locations.filter((b) => b.includes('add_header'))) {
      expect(body).toContain(INCLUDE);
    }
    const serverLevel = conf.replace(/location[^{]*\{[^}]*\}/g, '');
    expect(serverLevel).toContain(INCLUDE);
    expect(serverLevel).not.toMatch(/add_header/);
  });

  it('ships the snippet where the config includes it', () => {
    expect(dockerfile).toContain(
      'COPY docker/web-security-headers.conf /etc/nginx/snippets/security-headers.conf',
    );
  });
});
