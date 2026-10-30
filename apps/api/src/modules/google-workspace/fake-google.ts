/**
 * A Google that tests talk to instead of the real one: the token endpoint,
 * calendarList, colors, events (list, insert, get, patch, delete) and Gmail's
 * send. It keeps what it was asked, so a test can check the invitation went to
 * the lead and the owner, the Meet came back, the reschedule reached Google first.
 */

export interface FakeGoogleOptions {
  /** The account that "consents" (becomes the id_token's e-mail). */
  email?: string;
  /** Calendars this person sees, with their access. */
  calendars?: Array<{
    id: string;
    summary: string;
    primary?: boolean;
    accessRole: string;
    summaryOverride?: string;
    backgroundColor?: string;
    foregroundColor?: string;
    /** Hidden from the person's Google list: calendarList leaves it out unless showHidden=true. */
    hidden?: boolean;
  }>;
  /** How many reads an event's Meet stays "pending" before it exists. */
  meetPendingReads?: number;
  /** Refuses every refresh with invalid_grant (the person revoked the app). */
  refreshRevoked?: boolean;
  /** Answers this status to every events call (403 = no access to that calendar). */
  eventsStatus?: number;
  /** Answers this status to the events calls of one calendar only (by its id; 'primary' is the primary one's). */
  eventsStatusFor?: Record<string, number>;
  /** Answers this status to calendarList. */
  calendarListStatus?: number;
  /** The `error.errors[0].reason` sent with every refusal above (403 rateLimitExceeded is a usage limit). */
  refusalReason?: string;
  /** colors.get's `event` map; without it colors.get answers 404. */
  colors?: Record<string, { background: string; foreground: string }>;
  /** events.list answers at most this many items per page (default 250). */
  pageSize?: number;
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
  const primaryId = calendars.find((c) => c.primary)?.id ?? email;
  /** 'primary' and the primary calendar's id name the same calendar; ids compare case-insensitively. */
  const calendarKey = (id: string) => (id === 'primary' ? primaryId : id).toLowerCase();
  const calls: Array<{ method: string; url: string; body: unknown }> = [];
  const events = new Map<string, FakeEvent>();
  let tokenCounter = 0;
  let sentMail: Array<{ raw: string; threadId: string | null }> = [];

  const refusal = (code: number) => ({
    error: {
      code,
      ...(options.refusalReason ? { errors: [{ reason: options.refusalReason }] } : {}),
    },
  });

  const idToken = `h.${Buffer.from(JSON.stringify({ email })).toString('base64url')}.s`;
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  const eventAnswer = (event: FakeEvent) => {
    const pending = event.meetReadsLeft > 0;
    if (pending) event.meetReadsLeft -= 1;
    const conference = event.body.conferenceData as
      { entryPoints?: unknown; createRequest?: unknown } | undefined;
    // A seeded event that already carries its Meet is answered as it was given.
    const seededMeet = Boolean(conference?.entryPoints);
    const hasMeet = Boolean(conference);
    const attendees =
      (event.body.attendees as Array<{
        email: string;
        displayName?: string;
        responseStatus?: string;
      }>) ?? [];
    return {
      ...event.body,
      id: event.id,
      htmlLink:
        typeof event.body.htmlLink === 'string'
          ? event.body.htmlLink
          : `https://calendar.google.com/event?eid=${event.id}`,
      ...(hasMeet && !pending && !seededMeet
        ? { hangoutLink: `https://meet.google.com/${event.id}` }
        : {}),
      conferenceData: seededMeet
        ? conference
        : hasMeet
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
        ...a,
        email: a.email,
        displayName: a.displayName,
        responseStatus: a.responseStatus ?? 'needsAction',
      })),
    };
  };

  /** The start of an event in ms (all-day: midnight UTC of its date), for events.list's range. */
  const timeOf = (when: unknown) => {
    const w = (when ?? {}) as { dateTime?: unknown; date?: unknown };
    if (typeof w.dateTime === 'string') return Date.parse(w.dateTime);
    if (typeof w.date === 'string') return Date.parse(`${w.date}T00:00:00Z`);
    return Number.NaN;
  };

  const listAnswer = (calendarId: string, u: URL) => {
    const timeMin = Date.parse(u.searchParams.get('timeMin') ?? '');
    const timeMax = Date.parse(u.searchParams.get('timeMax') ?? '');
    const q = u.searchParams.get('q')?.toLowerCase() ?? null;
    const matching = [...events.values()].filter((event) => {
      if (event.deleted || calendarKey(event.calendarId) !== calendarKey(calendarId)) return false;
      const start = timeOf(event.body.start);
      const end = timeOf(event.body.end);
      if (!Number.isNaN(timeMax) && start >= timeMax) return false;
      if (!Number.isNaN(timeMin) && end <= timeMin) return false;
      if (
        q &&
        !String(event.body.summary ?? '')
          .toLowerCase()
          .includes(q)
      )
        return false;
      return true;
    });
    const size = options.pageSize ?? 250;
    const offset = Number(u.searchParams.get('pageToken') ?? '0');
    const page = matching.slice(offset, offset + size);
    return {
      items: page.map((event) => eventAnswer(event)),
      ...(offset + size < matching.length ? { nextPageToken: String(offset + size) } : {}),
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
      if (options.calendarListStatus)
        return json(options.calendarListStatus, refusal(options.calendarListStatus));
      const showHidden = u.searchParams.get('showHidden') === 'true';
      return json(200, { items: calendars.filter((c) => showHidden || !c.hidden) });
    }
    if (u.pathname === '/calendar/v3/colors') {
      if (!options.colors) return json(404, { error: { code: 404 } });
      return json(200, { kind: 'calendar#colors', calendar: {}, event: options.colors });
    }
    const eventsMatch = u.pathname.match(
      /^\/calendar\/v3\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/,
    );
    if (eventsMatch) {
      if (options.eventsStatus) return json(options.eventsStatus, refusal(options.eventsStatus));
      const calendarId = decodeURIComponent(eventsMatch[1]!);
      const eventId = eventsMatch[2] ? decodeURIComponent(eventsMatch[2]) : null;
      const calendarStatus = Object.entries(options.eventsStatusFor ?? {}).find(
        ([id]) => calendarKey(id) === calendarKey(calendarId),
      )?.[1];
      if (calendarStatus) return json(calendarStatus, refusal(calendarStatus));
      if (method === 'GET' && !eventId) return json(200, listAnswer(calendarId, u));
      if (method === 'POST') {
        const id = `evt${events.size + 1}`;
        const own = calendarKey(calendarId) === calendarKey('primary');
        const event: FakeEvent = {
          id,
          calendarId,
          body: {
            status: 'confirmed',
            // Google makes the calendar the organizer; on the person's own one, that is them.
            organizer: { email: own ? primaryId : calendarId, self: own },
            ...(body as Record<string, unknown>),
          },
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
    // The media upload takes the message itself; kept base64url like the JSON one, for the tests.
    if (u.pathname === '/upload/gmail/v1/users/me/messages/send' && rawBody) {
      sentMail.push({ raw: Buffer.from(rawBody, 'utf8').toString('base64url'), threadId: null });
      return json(200, { id: `msg${sentMail.length}`, threadId: `thr${sentMail.length}` });
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

  /** Puts an event on a calendar as Google would hold it (raw Calendar v3 fields). */
  const seed = (calendarId: string, raw: Record<string, unknown> & { id: string }) => {
    const { id, ...body } = raw;
    events.set(id, { id, calendarId, body, meetReadsLeft: 0, deleted: false });
  };

  return {
    transport,
    calls,
    events,
    seed,
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
