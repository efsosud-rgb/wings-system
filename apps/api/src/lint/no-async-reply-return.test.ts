import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import { noAsyncReplyReturn } from './no-async-reply-return.js';

RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });
const error = { messageId: 'asyncReply' };

tester.run('no-async-reply-return', noAsyncReplyReturn, {
  valid: [
    // The route handler itself: Fastify takes the reply it returns.
    `app.post('/x', async (request, reply) => reply.status(201).send({ ok: true }));`,
    `app.get('/x', async (request, reply) => {
       if (!request.query) return reply.code(400).send({ error: 'invalid' });
       return reply.redirect('/y');
     });`,
    `app.route({ method: 'GET', url: '/x', handler: async (request, reply) => { return reply.send(); } });`,
    `app.get('/x', { preHandler: [app.requireSession, async (request, reply) => reply.code(401).send()] },
       async () => ({}));`,
    `app.setErrorHandler(async (error, request, reply) => reply.status(500).send({ error: 'x' }));`,
    `async function handle(request, reply) { return reply.status(404).send(); }
     app.get('/x', handle);`,
    // A hook typed as Fastify's own handler type.
    `const requireAuth: preHandlerHookHandler = async (request, reply) => {
       if (!request.session) return reply.status(401).send({ error: 'unauthenticated' });
     };
     app.decorate('requireAuth', requireAuth);`,
    // A synchronous helper (offBrand in whatsapp/routes.ts): no await, so no thenable trap.
    `app.post('/x', async (request, reply) => {
       const offBrand = (words: string) =>
         words.includes('Wings') ? reply.status(422).send({ error: 'brand_voice' }) : null;
       const refused = offBrand(request.body.text);
       if (refused) return refused;
       return reply.send({ ok: true });
     });`,
    // The lesson's shape: the helper returns the reason, the handler sends and returns.
    `const overCallLimit = async (contactId: string) => ((await count(contactId)) > 1 ? 'limite' : null);
     app.post('/x', async (request, reply) => {
       const why = await overCallLimit('c1');
       if (why) return reply.status(429).send({ error: 'call_request_limit', message: why });
       return reply.send({ ok: true });
     });`,
    // A helper whose every call goes straight back to Fastify.
    `async function sendRecord(request, reply: FastifyReply) {
       const record = await load(request);
       if (!record) return reply.status(404).send({ error: 'not_found' });
       return reply.send(record);
     }
     app.get('/a', async (request, reply) => sendRecord(request, reply));
     app.get('/b', async (request, reply) => {
       if (!request.params) return reply.code(400).send();
       return request.query ? sendRecord(request, reply) : reply.send({});
     });`,
    // A helper whose result is thrown away: the caller reads the reply's state, not the value.
    `async function send(request, reply) { return reply.status(201).send({}); }
     async function sendOnce(request, reply, target: Parameters<typeof send>[1]) {
       await send(request, reply);
       return reply;
     }
     app.post('/x', async (request, reply) => sendOnce(request, reply, reply));`,
    // A callback given to a wrapper that hands its result straight back.
    `async function answer(reply, run: () => Promise<unknown>) {
       try { return await run(); } catch (e) { return reply.status(409).send({ error: 'x' }); }
     }
     app.get('/x', async (request, reply) => answer(reply, async () => reply.send(await load())));`,
    // A factory whose result is the route handler.
    `const guarded = (handler) => async (request, reply) => {
       if (!request.session) return reply.status(403).send({ error: 'forbidden' });
       return await handler(request, reply);
     };
     app.get('/x', read, guarded(async (request, reply) => reply.send({ tree: await tree() })));`,
    // Not a reply: another object's send, or a value read from the reply.
    `async function notify(mailer) { return mailer.send({ to: 'x' }); }
     const sent = await notify(mailer);`,
    `async function wasSent(reply) { await flush(); return reply.sent; }
     const sent = await wasSent(reply);`,
    // The right side of `??` is handed on: here it goes straight back to Fastify.
    `async function sendRecord(request, reply) { return reply.status(404).send({}); }
     app.get('/x', async (request, reply) => (await cached(request)) ?? sendRecord(request, reply));`,
  ],
  invalid: [
    // PR #66: the 429 was awaited into undefined and the request went on to Meta.
    {
      code: `const overCallLimit = async (reply: FastifyReply, contactId: string | null) => {
               const why = await callRequestRefusal(db, contactId);
               return why ? reply.status(429).send({ error: 'call_request_limit', message: why }) : null;
             };
             app.post('/x', async (request, reply) => {
               const limited = await overCallLimit(reply, 'c1');
               if (limited) return limited;
               await sendToMeta();
               return reply.send({ ok: true });
             });`,
      errors: [error],
    },
    {
      code: `async function deny(res: FastifyReply) { return res.code(403).send({ error: 'forbidden' }); }
             app.post('/x', async (request, reply) => {
               const denied = await deny(reply);
               if (denied) return denied;
               return reply.send({});
             });`,
      errors: [error],
    },
    {
      code: `async function toLogin(reply) { await audit(); return reply.redirect('/login'); }
             const gone = await toLogin(reply);`,
      errors: [error],
    },
    // A bare reply after sending is the same thenable.
    {
      code: `async function refuse(reply) { reply.status(409).send({}); return reply; }
             app.post('/x', async (request, reply) => {
               const refused = await refuse(reply);
               if (refused) return refused;
               return reply.send({});
             });`,
      errors: [error],
    },
    // A promise-typed helper that is not async.
    {
      code: `function later(reply): Promise<unknown> { return reply.status(202).send({}); }
             const answered = await later(reply);`,
      errors: [error],
    },
    // Exported: its callers are in other files, out of sight, so it is reported.
    {
      code: `export async function notFound(reply) { return reply.status(404).send({ error: 'not_found' }); }`,
      errors: [error],
    },
    // A wrapper that reads its callback's value instead of handing it back.
    {
      code: `async function guard(reply, run: () => Promise<unknown>) {
               const refused = await run();
               if (refused) return refused;
               return reply.send({});
             }
             app.get('/x', async (request, reply) => guard(reply, async () => reply.status(429).send({})));`,
      errors: [error],
    },
    // Both branches and an awaited send are followed.
    {
      code: `const check = async (reply, ok: boolean) => (ok ? null : await reply.code(400).send({}));
             const bad = await check(reply, false);`,
      errors: [error],
    },
    // The left side of `||`, `??` and `&&` is read: undefined there runs the right side.
    {
      code: `async function overLimit(reply) { return reply.status(429).send({ error: 'limit' }); }
             app.post('/x', async (request, reply) => (await overLimit(reply)) || sendToMeta());`,
      errors: [error],
    },
    {
      code: `async function overLimit(reply) { return reply.status(429).send({ error: 'limit' }); }
             app.post('/x', async (request, reply) => (await overLimit(reply)) ?? sendToMeta());`,
      errors: [error],
    },
    {
      code: `async function allowed(reply) { return reply.status(403).send({}); }
             app.post('/x', async (request, reply) => (await allowed(reply)) && audit());`,
      errors: [error],
    },
    // The reply kept in a constant, or returned before `send`, is the same thenable.
    {
      code: `async function refuse(reply) { const res = reply.code(429).send({}); return res; }
             const refused = await refuse(reply);`,
      errors: [error],
    },
    {
      code: `async function limit(reply) { await audit(); return reply.status(429); }
             const limited = await limit(reply);`,
      errors: [error],
    },
    // A callback given to a function received as a parameter: what that function does is unknown.
    {
      code: `async function run(reply, wrap) { return wrap(reply, async () => reply.status(429).send({})); }
             app.post('/x', async (request, reply) => run(reply, guard));`,
      errors: [error],
    },
  ],
});
