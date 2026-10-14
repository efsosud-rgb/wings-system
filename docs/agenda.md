# Agenda

> **State on 14/10/2026:** API and tests against the simulated Google (`fake-google.ts`). **Not
> verified live**: the first real read, create, edit and delete on staging are Eric's check (see
> the end of this file).

## What it is

A Google Calendar-like screen inside the Wings System (Eric, 14/10: "o módulo de agenda com o
Layout e as funcionalidades do Google Agenda"). Each person sees two calendars:

- **mine**: their own Google calendar (`primary`), under "Minhas agendas";
- **wings**: the Wings Company calendar (Thais' primary, `GOOGLE_WORKSPACE_WINGS_CALENDAR_ID`),
  under "Outras agendas", when Thais has shared it with them.

Both are read and written with **the person's own Google token** (the per-person connection in
[integracoes/google-workspace.md](integracoes/google-workspace.md)), so Google's sharing decides
what each person sees and may change. The system never acts on someone else's account, and the
browser never sees a Google calendar id: it names a calendar only by the key `mine` or `wings`.

The contract (types, schemas, notices, the event palette) is
`packages/shared/src/calendar.ts`; the API is `apps/api/src/modules/agenda/` (`google.ts` = the
Calendar v3 calls and the raw-to-`AgendaEvent` mapping, `service.ts` = the rules, `routes.ts`).

## Who opens it

Every level (`calendar.use`, held by every role with scope `own`). Sellers open it at
`/crm-vendas/agenda`, every other level at `/produtividade/agenda`. There is no route that takes an
employee id: a person reaches only their own Google account. `route-access.test.ts` checks that
every level opens `GET /agenda`.

## Routes

All with `preHandler: app.requirePermission('calendar.use')`.

| Route                                                               | Answer                                                                                         |
| ------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET /agenda`                                                       | `{ overview: AgendaOverview }`, always 200: a missing configuration or connection is a `state` |
| `GET /agenda/events?from=<ISO>&to=<ISO>&q=<text?>`                  | `AgendaEventsAnswer` (range at most 550 days)                                                  |
| `POST /agenda/events` (body `AgendaEventInput`)                     | 201 `{ event: AgendaEvent }`                                                                   |
| `PATCH /agenda/events/:calendar/:eventId` (body `AgendaEventPatch`) | `{ event: AgendaEvent }`                                                                       |
| `DELETE /agenda/events/:calendar/:eventId`                          | 204                                                                                            |

`:calendar` is `mine` or `wings` (anything else answers 404); `:eventId` is at most 1024
characters.

### The overview

- No OAuth client or integrations key → `state: 'not_configured'`.
- `accessTokenFor` → `not_connected`, `needs_reconnect`, or `google_unreachable` (Google did not
  answer the refresh).
- `calendarList` (`minAccessRole=reader`, `showHidden=true`, so a shared calendar the person hid
  on their Google list still counts): `mine` is the primary entry (name =
  `summaryOverride ?? summary`, colours from the entry, `canWrite` = owner/writer). The Wings
  Company entry is named by the person's own `summaryOverride`, else "Wings Company": its Google
  name is Thais' account. The Wings
  Company calendar is `not_configured` (env unset), `is_mine` (the primary id equals the Wings id,
  case-insensitive: Thais; only `mine` is listed), `writer` (owner/writer), `reader` (listed,
  `canWrite: false`) or `not_shared` (not listed). A 401 on the list → `needs_reconnect`; any other
  failure → `google_unreachable`.
- Event colours: `colors.get`'s `event` map (`eventColorsSource: 'google'`); when that call fails,
  `GOOGLE_EVENT_COLORS` stands in (`'default'`).
- While `state` is not `ready`, `wings` is `not_configured` when the env id is unset and
  `not_shared` otherwise: unknown, so the screen reads `state` first.

### Events

`mine` (`calendarId=primary`) and `wings` (when `writer` or `reader`, never on `is_mine`) are read
in parallel with `events.list`: `timeMin`, `timeMax`, `singleEvents=true`, `orderBy=startTime`,
`maxResults=2500`, `timeZone=America/Sao_Paulo`, `showDeleted=false`, `q` when given. Up to three
pages per calendar; `truncated: true` when Google had more.

- A calendar that fails goes to `failures[{ calendar, code, message }]` and the other is still
  answered (200): its events are missing, never shown as none.
- A token problem (not connected, needs reconnect, a 401) answers 409 for the whole request.
- Cancelled events and `workingLocation` markers are dropped.
- Mapping: a timed start/end becomes an ISO instant, an all-day one the `YYYY-MM-DD` date (end
  exclusive, as Google). The description is reduced from Google's HTML to plain text (line breaks
  kept, tags stripped, entities decoded); the screen never renders HTML. `meetUrl` is the video
  entry point, or `hangoutLink`, and only when it is an `https://meet.google.com/` address: an
  outside organizer writes the conference data, so any other link is left out rather than labelled
  a Meet. Resource rooms are left out of the guests. `uid` is `iCalUID`
  (the same event on both calendars shares it, so the screen shows it once). `guestsNotified` is
  true when this is the organizer's copy (the person's, or the calendar's own) and it has guests:
  deleting a guest's copy only takes it off that person's calendar, and the confirmation says so.

## The edit rule

`canEdit` is true only when all hold:

1. the person is owner or writer on the event's calendar;
2. the event is the calendar's own: `organizer.self`, or the organizer is the calendar itself (its
   real id, case-insensitive), or Google lets guests modify it (`guestsCanModify`);
3. it is not a birthday or an event Gmail made (`eventType` `birthday` / `fromGmail`);
   out-of-office stays editable;
4. it is not a CRM meeting.

A guest who does not organize an event only sees it. `PATCH` and `DELETE` re-read the event and
re-check the rule on the server (409 `event_not_editable`); the screen's `canEdit` is convenience
only.

An occurrence of a recurring event is patched or deleted **by its own id**: only that occurrence
changes, and the screen says so. Creating recurring events, RSVP and drag-and-drop are a later
stage.

### What an edit sends

Only the fields given. Times go together; switching all-day ↔ timed sets the other key to null
(`start: { date, dateTime: null, timeZone: null }`). A null location or description clears it
(`''`); a null `colorId` clears the colour. Guests: everyone flagged organizer, self or resource
stays as Google had them; guests still listed keep their record (their answer); new e-mails come in
bare; the rest leave. `createMeet: true` adds a Meet only when the event has none
(`conferenceDataVersion=1`); a Meet is never removed. `sendUpdates=all` when the event has or will
have guests other than the person, else `none`.

A create sends the title, place, description (plain text), start/end (`dateTime` in São Paulo, or
`date`), guests and colour; a Meet when asked (`conferenceData.createRequest`,
`conferenceDataVersion=1`); `sendUpdates=all` only with guests. A Meet still `pending` is re-read
up to three times (a failed re-read counts as "never came"); if it never appears the event is
deleted and the answer is 502 `meet_failed`. When that delete fails too, the answer is 502
`meet_failed_event_kept` with the event's `htmlLink`, never "not created". A create whose answer
was lost (network) asks to check Google Agenda before trying again, since Google may have made it.
`wings` needs `writer` (409 `wings_calendar_forbidden` otherwise); on Thais' account `wings` writes
to her primary and the event comes back as `mine`.

## CRM meetings

A deal's meeting (a `crm_meetings` row whose `google_event_id` is the event's id or its series id,
status not `cancelada`) is shown with `crm: { leadId }` and `canEdit: false`. It is **never** moved
or cancelled from the Agenda: `PATCH` and `DELETE` answer 409 `crm_meeting` with `leadId`, and the
details show "Abrir negociação" (`agendaDealPath`). `leadId` is set only when the person may open
that deal (`leadVisibleTo(actor, 'leads.read', …)` in `modules/leads/access.ts`: the owner seller,
the Admin, Diretoria); another seller gets `leadId: null`. No lead data goes into the answer beyond
what Google itself shows the person.

## Errors

`{ error: <code>, message: <Portuguese> }`:

| Status | Code                                                   | When                                                                  |
| ------ | ------------------------------------------------------ | --------------------------------------------------------------------- |
| 400    | `invalid_request`                                      | the query or body fails the shared schema (message = the first issue) |
| 503    | `google_not_configured`                                | no OAuth client or integrations key                                   |
| 409    | `google_not_connected`                                 | the person never connected (`AGENDA_NOTICES.notConnected`)            |
| 409    | `google_needs_reconnect`                               | Google refused the refresh, or answered 401                           |
| 409    | `wings_calendar_forbidden`                             | Wings Company not shared, read-only, or Google answered 403 on it     |
| 409    | `crm_meeting`                                          | a deal's meeting (+ `leadId`)                                         |
| 409    | `event_not_editable`                                   | the edit rule, or Google answered 403 on the person's own calendar    |
| 404    | `event_not_found`                                      | unknown, cancelled or gone event; unknown calendar key                |
| 502    | `google_rejected`, `google_unreachable`, `meet_failed` | Google refused, did not answer, or never made the Meet                |
| 502    | `google_rate_limited`                                  | Google answered 429, or 403 with a usage-limit reason                 |
| 502    | `meet_failed_event_kept`                               | no Meet and the cleanup failed: the event may be on Google (+ link)   |

A 403 from Google is read by its reason (`error.errors[0].reason`, never the message): a usage
limit (`rateLimitExceeded`, `userRateLimitExceeded`, `quotaExceeded`, `dailyLimitExceeded`) is a
pause, anything else a refusal. A Google refusal is never answered as 403: that status belongs to the permission gate, and
`route-access.test.ts` reads 403 as "module closed".

## Google calls and scopes

`calendarList.list`, `colors.get`, `events.list`, `events.get`, `events.insert`, `events.patch`,
`events.delete`, all through `calendarRequest` in `google-workspace/calendar.ts`. Scopes are the
connection's and no new one is asked for: `openid`, `email`, `calendar.events` (events),
`calendar.calendarlist.readonly` (calendarList and colors.get), `gmail.send`.

## Audit and logs

`calendar.event_created`, `calendar.event_updated`, `calendar.event_deleted`, entity
`calendar_event`, entity id = the Google event id, metadata `{ calendar: 'mine' | 'wings' }` only:
never a title, guest, place or time. Nothing in the module logs event content or the search text.
No migration.

## Not done yet

- Creating recurring events, editing a whole series, RSVP (answering an invitation),
  drag-and-drop.
- Moving an event between calendars.
- Calendars other than the two above (other shared calendars of the person are not listed).

## How Eric checks it on staging

1. Log in as a seller who connected Google in **Minha conta** and open CRM Vendas → Agenda; log in
   as another level and open Produtividade → Agenda. Both open.
2. The person's own events appear under "Minhas agendas" with Google's colours; the Wings Company
   events under "Outras agendas" when Thais shared the calendar (read-only when shared for
   viewing only, with the notice to ask Thais).
3. Create an event with a Meet on "mine": it appears on Google Agenda with the Meet link. Edit its
   time, then delete it: Google follows.
4. Open a deal meeting made in the CRM: the details offer "Abrir negociação", no edit or delete.
5. Open an event someone else organized: it is view-only.
6. Log in as Thais: only her calendar is listed, once.
