import { fileURLToPath } from 'node:url';
import Fastify from 'fastify';

const PORT = Number(process.env.API_PORT ?? 3000);

export function buildServer() {
  const app = Fastify({
    logger: true,
    // Behind Traefik: trust the proxy headers so request IPs in the audit log are real.
    trustProxy: true,
  });

  // Routes are registered WITHOUT the /api prefix: Traefik (Coolify path
  // routing) strips it before forwarding, and the Vite dev proxy rewrites it
  // the same way. The public URL is always https://<host>/api/...
  app.get('/health', async () => ({
    status: 'ok',
    service: 'wings-system-api',
    time: new Date().toISOString(),
  }));

  return app;
}

// Only listen when run directly, so tests can import buildServer() without binding a port.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const app = buildServer();
  app.listen({ port: PORT, host: '0.0.0.0' }).catch((err: unknown) => {
    app.log.error(err);
    process.exit(1);
  });
}
