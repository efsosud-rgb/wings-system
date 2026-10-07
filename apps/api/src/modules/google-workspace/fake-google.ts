/**
 * A Google that tests talk to instead of the real one: the token endpoint,
 * calendarList, events (insert, get, patch, delete) and Gmail's send. It keeps
 * what it was asked, so a test can check the invitation went to the lead and
 * the owner, the Meet came back, the reschedule reached Google first.
 */

export interface FakeGoogleOptions {
  /** The account that "consents" (becomes the id_token's e-mail). */
  email?: string;
  /** Calendars this person sees, with their access. */
  calendars?: Array<{ id: string; summary: string; primary?: boolean; accessRole: string }>;
  /** How many reads an event's Meet stays "pending" before it exists. */
  meetPendingReads?: number;
  /** Refuses every refresh with invalid_grant (the person revoked the app). */
  refreshRevoked?: boolean;
  /** Answers this status to every events call (403 = no access to that calendar). */
  eventsStatus?: number;
}

export interface FakeEvent {
  id: string;
  calendarId: string;
  body: Record<string, unknown>;
  meetReadsLeft: number;
  deleted: boolean;
}

export function fakeGoogle(options: FakeGoogleOptions = {}) {
  const email = options.email ?? 'vendedor@wingscompany.com.br';
  const calendars = options.calendars ?? [
    { id: email, summary: email, primary: true, accessRole: 'owner' },
  ];
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const events = new Map<string, FakeEvent>();
  let tokenCounter = 0;
  let sentMail: Array<{ raw: string; threadId: string | null }> = [];

  const idToken = `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const eventAnswer = (event: FakeEvent) => {
    const pending = event.meetReadsLeft > 0;
    if (pending) event.meetReadsLeft -= 1;
    const hasMeet = Boolean(event.body.conferenceData);
    const attendees =
      (event.body.attendees as Array<{ email: string; displayName?: string }>) ?? [];
    return {
      id: event.id,
      htmlLink: `https://calendar.google.com/event?eid=${event.id}`,
      ...(hasMeet && !pending ? { hangoutLink: `https://meet.google.com/${event.id}` } : {}),
      conferenceData: hasMeet
        ? {
            createRequest: { status: { statusCode: pending ? 'pending' : 'success' } },
            ...(pending
              ? {}
              : {
                  entryPoints: [
                    { entryPointType: 'video', uri: `https://meet.google.com/${event.id}` },
                  ],
                }),
          }
        : undefined,
      attendees: attendees.map((a) => ({
        email: a.email,
        displayName: a.displayName,
        responseStatus: 'needsAction',
      })),
    };
  };

  const transport: typeof fetch = async (input, init) => {
    const url =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method ?? 'GET';
    const rawBody = typeof init?.body === 'string' ? init.body : null;
    const body =
      rawBody &&
      init?.headers &&
      (init.headers as Record<string, string>)['content-type'] === 'application/json'
        ? (JSON.parse(rawBody) as Record<string, unknown>)
        : rawBody
          ? Object.fromEntries(new URLSearchParams(rawBody))
          : null;
    calls.push({ method, url, body });
    const u = new URL(url);

    if (u.href.startsWith('https://oauth2.googleapis.com/token')) {
      const grant = (body as Record<string, string>).grant_type;
      if (grant === 'refresh_token' && options.refreshRevoked) {
        return json(400, { error: 'invalid_grant' });
      }
      tokenCounter += 1;
      return json(200, {
        access_token: `access-${tokenCounter}`,
        ...(grant === 'authorization_code'
          ? { refresh_token: 'refresh-1', id_token: idToken }
          : {}),
        expires_in: 3600,
        scope: 'openid email https://www.googleapis.com/auth/calendar.events',
        token_type: 'Bearer',
      });
    }
    if (u.href.startsWith('https://oauth2.googleapis.com/revoke')) return json(200, {});

    const auth = (init?.headers as Record<string, string> | undefined)?.authorization ?? '';
    if (!auth.startsWith('Bearer access-')) return json(401, { error: { code: 401 } });

    if (u.pathname === '/calendar/v3/users/me/calendarList') {
      return json(200, { items: calendars });
    }
    const eventsMatch = u.pathname.match(
      /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/,
    );
    if (eventsMatch) {
      if (options.eventsStatus)
        return json(options.eventsStatus, { error: { code: options.eventsStatus } });
      const calendarId = decodeURIComponent(eventsMatch[1]!);
      const eventId = eventsMatch[2] ? decodeURIComponent(eventsMatch[2]) : null;
      if (method === 'POST') {
        const id = `evt${events.size + 1}`;
        const event: FakeEvent = {
          id,
          calendarId,
          body: body as Record<string, unknown>,
          meetReadsLeft: options.meetPendingReads ?? 0,
          deleted: false,
        };
        events.set(id, event);
        return json(200, eventAnswer(event));
      }
      const event = eventId ? events.get(eventId) : undefined;
      if (!event || event.deleted) return json(404, { error: { code: 404 } });
      if (method === 'GET') return json(200, eventAnswer(event));
      if (method === 'PATCH') {
        event.body = { ...event.body, ...(body as Record<string, unknown>) };
        return json(200, eventAnswer(event));
      }
      if (method === 'DELETE') {
        event.deleted = true;
        return new Response(null, { status: 204 });
      }
    }
    if (u.pathname === '/gmail/v1/users/me/messages/send') {
      const sent = body as { raw: string; threadId?: string };
      sentMail.push({ raw: sent.raw, threadId: sent.threadId ?? null });
      return json(200, {
        id: `msg${sentMail.length}`,
        threadId: sent.threadId ?? `thr${sentMail.length}`,
      });
    }
    return json(404, { error: { code: 404, message: 'fake google: unknown route' } });
  };

  return {
    transport,
    calls,
    events,
    get sentMail() {
      return sentMail;
    },
    reset() {
      calls.length = 0;
      events.clear();
      sentMail = [];
    },
  };
}
