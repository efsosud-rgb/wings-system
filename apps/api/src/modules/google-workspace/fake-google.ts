/**
 * A Google that tests talk to instead of the real one: the token endpoint,
 * calendarList, colors, events (list, insert, get, patch, delete) and Gmail's
 * send. It keeps what it was asked, so a test can check the invitation went to
 * the lead and the owner, the Meet came back, the reschedule reached Google first.
 * Its Gmail also has an inbox (`deliver`) read through the history, the search, a message
 * and its attachments, as the reading of the leads' replies does (t083).
 * Every call must carry a time limit (`signal`), or it is refused: a call without one could hold a
 * pass or a click for minutes (aj02).
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
  /** The scopes the token endpoint says were granted (default: the Agenda only, as before t083). */
  grantedScopes?: string[];
  /** history.list answers at most this many records per page (default 100). */
  historyPageSize?: number;
}

/** A message in the fake inbox, as a test writes it. */
export interface FakeMail {
  threadId?: string;
  labelIds?: string[];
  /** Header name → value (From, Subject, Message-ID, In-Reply-To, References…). */
  headers: Record<string, string>;
  text?: string;
  html?: string;
  attachments?: { filename: string; mimeType: string; data: Buffer; inline?: boolean }[];
  at?: Date;
  /** Not in Gmail's search yet (its index lags behind the inbox) until `index(id)`. */
  unindexed?: boolean;
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
  type StoredMail = FakeMail & { id: string; threadId: string; labelIds: string[]; at: Date };
  const inbox: StoredMail[] = [];
  let historyPoint = 1000;
  /** History records before this point are gone, as Gmail forgets them after about a week. */
  let historyFloor = 0;
  const history: Array<{ id: number; messages: { id: string; threadId: string }[] }> = [];

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
    if (!(init?.signal instanceof AbortSignal))
      throw new Error('fake google: a call without a time limit (AbortSignal.timeout)');
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
        scope: (
          options.grantedScopes ?? [
            'openid',
            'email',
            'https://www.googleapis.com/auth/calendar.events',
          ]
        ).join(' '),
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

    if (u.pathname.startsWith('/gmail/v1/users/me/') && method === 'GET') {
      if (u.pathname === '/gmail/v1/users/me/profile')
        return json(200, { historyId: String(historyPoint) });
      if (u.pathname === '/gmail/v1/users/me/history') {
        const start = Number(u.searchParams.get('startHistoryId'));
        if (start < historyFloor) return json(404, { error: { code: 404 } });
        const after = history.filter((h) => h.id > start);
        const size = options.historyPageSize ?? 100;
        const offset = Number(u.searchParams.get('pageToken') ?? '0');
        const page = after.slice(offset, offset + size);
        return json(200, {
          ...(page.length
            ? {
                history: page.map((h) => ({
                  id: String(h.id),
                  messagesAdded: h.messages.map((message) => ({ message })),
                })),
              }
            : {}),
          historyId: String(historyPoint),
          ...(offset + size < after.length ? { nextPageToken: String(offset + size) } : {}),
        });
      }
      if (u.pathname === '/gmail/v1/users/me/messages') {
        const q = u.searchParams.get('q') ?? '';
        const from = (/from:\(([^)]*)\)/.exec(q)?.[1] ?? '')
          .split(' OR ')
          .map((a) => a.toLowerCase());
        const after = Number(/after:(\d+)/.exec(q)?.[1] ?? '0');
        const found = inbox.filter((m) => {
          const address = (
            /<([^>]+)>/.exec(m.headers.From ?? '')?.[1] ??
            m.headers.From ??
            ''
          ).toLowerCase();
          return (
            !m.unindexed &&
            m.labelIds.includes('INBOX') &&
            from.includes(address) &&
            m.at.getTime() / 1000 > after
          );
        });
        return json(200, found.length ? { messages: found.map((m) => ({ id: m.id })) } : {});
      }
      const attachment = u.pathname.match(
        /^\/gmail\/v1\/users\/me\/messages\/([^/]+)\/attachments\/([^/]+)$/,
      );
      if (attachment) {
        const mail = inbox.find((m) => m.id === decodeURIComponent(attachment[1]!));
        const index = Number(/-(\d+)$/.exec(decodeURIComponent(attachment[2]!))?.[1]);
        const file = mail?.attachments?.[index];
        if (!file) return json(404, { error: { code: 404 } });
        return json(200, { data: file.data.toString('base64url') });
      }
      const one = u.pathname.match(/^\/gmail\/v1\/users\/me\/messages\/([^/]+)$/);
      if (one) {
        const mail = inbox.find((m) => m.id === decodeURIComponent(one[1]!));
        if (!mail) return json(404, { error: { code: 404 } });
        const headers = Object.entries(mail.headers).map(([name, value]) => ({ name, value }));
        if (u.searchParams.get('format') === 'metadata') {
          const wanted = u.searchParams.getAll('metadataHeaders').map((h) => h.toLowerCase());
          // `fields=internalDate,payload/headers`: the headers asked for and when it arrived.
          return json(200, {
            internalDate: String(mail.at.getTime()),
            payload: { headers: headers.filter((h) => wanted.includes(h.name.toLowerCase())) },
          });
        }
        const part = (mimeType: string, text: string) => ({
          mimeType,
          filename: '',
          headers: [{ name: 'Content-Type', value: `${mimeType}; charset=UTF-8` }],
          body: { data: Buffer.from(text, 'utf8').toString('base64url') },
        });
        return json(200, {
          id: mail.id,
          threadId: mail.threadId,
          labelIds: mail.labelIds,
          internalDate: String(mail.at.getTime()),
          payload: {
            mimeType: 'multipart/mixed',
            headers,
            parts: [
              ...(mail.text !== undefined ? [part('text/plain', mail.text)] : []),
              ...(mail.html !== undefined ? [part('text/html', mail.html)] : []),
              ...(mail.attachments ?? []).map((file, index) => ({
                mimeType: file.mimeType,
                filename: file.filename,
                headers: [
                  {
                    name: 'Content-Disposition',
                    value: `${file.inline ? 'inline' : 'attachment'}; filename="${file.filename}"`,
                  },
                ],
                body: { attachmentId: `att-${mail.id}-${index}`, size: file.data.length },
              })),
            ],
          },
        });
      }
    }
    // The multipart upload: a JSON part (the threadId), then the message; kept base64url like the JSON one.
    if (u.pathname === '/upload/gmail/v1/users/me/messages/send' && rawBody) {
      const threadId = /\{"threadId":"([^"]+)"\}/.exec(rawBody)?.[1] ?? null;
      const message = rawBody.split('Content-Type: message/rfc822\r\n\r\n')[1] ?? rawBody;
      const raw = message.replace(/\r\n--wings-[0-9a-f]+--\r\n$/, '');
      sentMail.push({ raw: Buffer.from(raw, 'utf8').toString('base64url'), threadId });
      return json(200, {
        id: `msg${sentMail.length}`,
        threadId: threadId ?? `thr${sentMail.length}`,
      });
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

  let mailCounter = 0;
  /** Messages arrive in the inbox together: one history record with all of them (an import, a filter). */
  const deliverTogether = (mails: FakeMail[]) => {
    historyPoint += 1;
    const stored = mails.map((mail): StoredMail => {
      mailCounter += 1;
      return {
        ...mail,
        id: `in${historyPoint}-${mailCounter}`,
        threadId: mail.threadId ?? `tin${historyPoint}-${mailCounter}`,
        labelIds: mail.labelIds ?? ['INBOX', 'UNREAD'],
        at: mail.at ?? new Date(),
      };
    });
    inbox.push(...stored);
    history.push({
      id: historyPoint,
      messages: stored.map((m) => ({ id: m.id, threadId: m.threadId })),
    });
    return stored;
  };
  /** A message arrives in the inbox: a new history record, as Gmail writes one. */
  const deliver = (mail: FakeMail) => deliverTogether([mail])[0]!;

  return {
    transport,
    calls,
    events,
    seed,
    deliver,
    deliverTogether,
    /** Gmail's search catches up with a message delivered `unindexed`. */
    index(id: string) {
      const mail = inbox.find((m) => m.id === id);
      if (mail) mail.unindexed = false;
    },
    /** Gmail forgets the history up to now (a point older than this answers 404). */
    expireHistory() {
      historyPoint += 1;
      historyFloor = historyPoint;
    },
    get sentMail() {
      return sentMail;
    },
    reset() {
      calls.length = 0;
      events.clear();
      sentMail = [];
      inbox.length = 0;
      history.length = 0;
      historyFloor = 0;
    },
  };
}
