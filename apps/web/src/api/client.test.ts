import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError } from './client.js';
import { onUnauthorized } from './session-expiry.js';

/**
 * The HTTP client is where a dead session is noticed: every request of the app
 * goes through it, so one place can stop what a tab keeps asking.
 */

const answer = (status: number, body: string) => new Response(body, { status });

function serve(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  onUnauthorized(null);
  vi.unstubAllGlobals();
});

describe('api client — a dead session', () => {
  it('reports a 401 to the session guard and still throws it', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    serve(answer(401, '{"error":"session_expired","message":"Sessão expirada"}'));

    await expect(api.get('/crm/tasks?status=open')).rejects.toMatchObject({
      status: 401,
      code: 'session_expired',
    });
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it('reports the 401 of a periodic read as well', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    const fetchMock = serve(answer(401, '{"error":"unauthenticated"}'));

    await expect(api.poll('/whatsapp/calls/ringing')).rejects.toBeInstanceOf(ApiError);
    expect(guard).toHaveBeenCalledTimes(1);
    const headers = (fetchMock.mock.calls[0]?.[1] as RequestInit).headers as Record<string, string>;
    expect(headers['x-wings-passive']).toBe('1');
  });

  it('does not take a wrong password for an expired session', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    serve(answer(401, '{"error":"invalid_credentials","message":"E-mail ou senha incorretos"}'));

    await expect(api.post('/auth/login', { email: 'a@b.c', password: 'x' })).rejects.toMatchObject({
      status: 401,
      code: 'invalid_credentials',
    });
    expect(guard).not.toHaveBeenCalled();
  });

  it.each([400, 403, 404, 429, 500, 503])(
    'does not treat a %i as a lost session',
    async (status) => {
      const guard = vi.fn();
      onUnauthorized(guard);
      serve(answer(status, '{"error":"x"}'));

      await expect(api.get('/anything')).rejects.toMatchObject({ status });
      expect(guard).not.toHaveBeenCalled();
    },
  );

  it('does not report a success', async () => {
    const guard = vi.fn();
    onUnauthorized(guard);
    serve(answer(200, '{"ok":true}'));

    await expect(api.get('/ok')).resolves.toEqual({ ok: true });
    expect(guard).not.toHaveBeenCalled();
  });
});

describe('api client — answers that are not JSON', () => {
  it('a proxy error page is an ApiError with its status, not a SyntaxError', async () => {
    serve(answer(502, '<html><body>Bad Gateway</body></html>'));

    const error = await api.get('/crm/tasks').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).status).toBe(502);
  });

  it('a 200 that is not JSON is an ApiError the screens can name', async () => {
    serve(answer(200, '<html>login portal</html>'));

    const error = await api.get('/crm/tasks').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe('bad_response');
  });

  it('an empty body is still an empty object', async () => {
    serve(answer(200, ''));
    await expect(api.get('/empty')).resolves.toEqual({});
  });
});
