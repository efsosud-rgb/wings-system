/**
 * A scripted Meta Graph API for tests: enough of the read and write surface for
 * a campaign to be created with its media, ad set, creatives and ads, with
 * state, so a create followed by a re-read behaves as it would live.
 *
 * Nothing here talks to Meta. It exists because every real Meta write happens
 * with a person watching, and everything before that is rehearsal.
 */

export type MetaEdge = 'campaigns' | 'adimages' | 'advideos' | 'adsets' | 'adcreatives' | 'ads';

export interface RecordedMetaCall {
  method: string;
  path: string;
  query: Record<string, string>;
  /** Form fields of a POST, files reduced to their byte length. */
  fields: Record<string, string>;
  headers: Record<string, string>;
}

export interface FakeMetaApiOptions {
  accountId?: string;
  /** Make one write edge fail, and how. */
  failOn?: { edge: MetaEdge; mode: 'reject' | 'server_error' | 'network_failure' };
  /** Statuses Meta reports while processing a video, in order. Ends on the last. */
  videoStatuses?: string[];
  /** Bytes Meta asks for per transfer round. */
  videoChunkSize?: number;
  pages?: { id: string; name: string }[];
  instagramAccounts?: { id: string; username: string }[];
  /** Extra cities for the location search, beyond the defaults. */
  cities?: { key: string; name: string; region: string }[];
  /** The account's spend_cap and amount_spent, both minor-unit strings — what `getAccount` reads. */
  spendCapCents?: string;
  amountSpentCents?: string;
  /** Ad sets that already exist on the account, as `listAdSets` reads them. */
  existingAdSets?: { id: string; campaign_id: string; name: string; status: string }[];
}

const REGIONS = [
  { key: '460', name: 'São Paulo', type: 'region', country_code: 'BR' },
  { key: '454', name: 'Paraná', type: 'region', country_code: 'BR' },
  { key: '449', name: 'Minas Gerais', type: 'region', country_code: 'BR' },
];

const CITIES = [
  { key: '269969', name: 'Campinas', region: 'São Paulo', country_code: 'BR' },
  { key: '268478', name: 'Curitiba', region: 'Paraná', country_code: 'BR' },
  // Two of the same name in one state: Meta cannot tell which is meant.
  { key: '1', name: 'Bom Jesus', region: 'Minas Gerais', country_code: 'BR' },
  { key: '2', name: 'Bom Jesus', region: 'Minas Gerais', country_code: 'BR' },
];

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

export function fakeMetaApi(options: FakeMetaApiOptions = {}) {
  const accountId = options.accountId ?? 'act_694058302567457';
  const calls: RecordedMetaCall[] = [];
  const state = {
    failOn: options.failOn,
    campaigns: [] as { id: string; name: string; status: string; daily_budget: string }[],
    /** Ad sets and ads created here, by id, with the status Meta would report. */
    objects: new Map<string, { edge: 'adsets' | 'ads'; status: string }>(),
    /** An id whose status update Meta refuses (400), to test a resume that fails part-way. */
    refuseStatusOn: undefined as string | undefined,
    videoStatuses: [...(options.videoStatuses ?? ['ready'])],
    videoBytes: new Map<string, number>(),
    spendCapCents: options.spendCapCents ?? '400000',
    amountSpentCents: options.amountSpentCents ?? '0',
  };
  const sizes = new Map<string, number>();
  let nextId = 120_210_000_000_000;
  const newId = () => String(nextId++);

  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });

  async function fieldsOf(init?: RequestInit): Promise<Record<string, string>> {
    const body = init?.body;
    const fields: Record<string, string> = {};
    if (typeof body === 'string') {
      for (const [key, value] of new URLSearchParams(body)) fields[key] = value;
    } else if (body instanceof FormData) {
      for (const [key, value] of body.entries()) {
        fields[key] = typeof value === 'string' ? value : `<${value.size} bytes>`;
      }
    }
    return fields;
  }

  function failure(edge: MetaEdge): Response | 'network' | null {
    if (state.failOn?.edge !== edge) return null;
    if (state.failOn.mode === 'network_failure') return 'network';
    if (state.failOn.mode === 'server_error') return json(500, { error: { message: 'oops' } });
    return json(400, {
      error: { code: 100, error_subcode: 1815857, message: `Invalid parameter on ${edge}` },
    });
  }

  function get(path: string, query: Record<string, string>): Response {
    if (path === 'search' && query.type === 'adgeolocation') {
      const q = fold(query.q ?? '');
      const wantsRegion = (query.location_types ?? '').includes('region');
      const pool = wantsRegion ? REGIONS : [...CITIES, ...(options.cities ?? [])];
      return json(200, { data: pool.filter((row) => fold(row.name).includes(q)) });
    }
    if (path === 'search' && query.type === 'adlocale') {
      return json(200, {
        data: [
          { key: 31, name: 'Portuguese (Brazil)' },
          { key: 32, name: 'Portuguese (Portugal)' },
        ],
      });
    }
    if (path === 'me/accounts') {
      return json(200, {
        data: options.pages ?? [{ id: '104567890123456', name: 'Wings Company' }],
      });
    }
    if (path === `${accountId}/promote_pages`) {
      return json(200, { data: options.pages ?? [] });
    }
    if (path === `${accountId}/instagram_accounts`) {
      return json(200, {
        data: options.instagramAccounts ?? [{ id: '17841400000000000', username: 'wingscompany' }],
      });
    }
    if (path === `${accountId}/campaigns`) return json(200, { data: state.campaigns });
    if (path === `${accountId}/adsets`) return json(200, { data: options.existingAdSets ?? [] });
    if (path === `${accountId}/insights`) return json(200, { data: [] });
    if (path === accountId && query.fields === 'funding_source_details') {
      return json(200, { id: accountId });
    }
    if (path === accountId) {
      return json(200, {
        id: accountId,
        currency: 'BRL',
        spend_cap: state.spendCapCents,
        amount_spent: state.amountSpentCents,
        account_status: 1,
      });
    }

    const campaign = state.campaigns.find((item) => item.id === path);
    if (campaign) return json(200, campaign);
    const object = state.objects.get(path);
    if (object)
      return json(200, { id: path, status: object.status, effective_status: object.status });

    if (path.endsWith('/thumbnails')) {
      return json(200, {
        data: [
          { uri: 'https://scontent.xx.fbcdn.net/t/first.jpg', is_preferred: false },
          { uri: 'https://scontent.xx.fbcdn.net/t/preferred.jpg', is_preferred: true },
        ],
      });
    }
    if (path.endsWith('/previews')) {
      return json(200, {
        data: [
          {
            body: `<iframe src="https://www.facebook.com/ads/api/preview_iframe.php?d=abc&amp;t=${query.ad_format}" width="540" height="690" scrolling="yes" style="border: none;"></iframe>`,
          },
        ],
      });
    }
    if (state.videoBytes.has(path)) {
      const status =
        state.videoStatuses.length > 1 ? state.videoStatuses.shift() : state.videoStatuses[0];
      return json(200, { status: { video_status: status } });
    }
    return json(400, { error: { code: 100, message: `Unsupported get request: ${path}` } });
  }

  function post(path: string, fields: Record<string, string>): Response {
    const edge = path.split('/')[1] as MetaEdge;

    if (edge === 'advideos') {
      const phase = fields.upload_phase;
      if (phase === 'start') {
        const failed = failure('advideos');
        if (failed && failed !== 'network') return failed;
        const videoId = newId();
        const size = Number(fields.file_size);
        state.videoBytes.set(videoId, 0);
        const chunk = options.videoChunkSize ?? size;
        return json(200, {
          upload_session_id: `session-${videoId}`,
          video_id: videoId,
          start_offset: '0',
          end_offset: String(Math.min(chunk, size)),
          __size: size,
        });
      }
      const videoId = String(fields.upload_session_id ?? '').replace('session-', '');
      if (phase === 'transfer') {
        const sent = Number(/<(\d+) bytes>/.exec(fields.video_file_chunk ?? '')?.[1] ?? 0);
        const received = Number(fields.start_offset) + sent;
        state.videoBytes.set(videoId, received);
        const size = sizes.get(videoId) ?? received;
        const chunk = options.videoChunkSize ?? size;
        return json(200, {
          start_offset: String(received),
          end_offset: String(Math.min(received + chunk, size)),
        });
      }
      return json(200, { success: true });
    }

    // A status change on an object that exists: campaign, ad set or ad.
    if (!path.includes('/') && fields.status) {
      if (state.refuseStatusOn === path) {
        return json(400, { error: { code: 100, message: `Cannot change status of ${path}` } });
      }
      const campaign = state.campaigns.find((item) => item.id === path);
      if (campaign) campaign.status = fields.status;
      const object = state.objects.get(path);
      if (object) object.status = fields.status;
      if (campaign || object) return json(200, { success: true });
    }

    const failed = failure(edge);
    if (failed && failed !== 'network') return failed;

    if (edge === 'campaigns') {
      const id = newId();
      state.campaigns.push({
        id,
        name: fields.name ?? '',
        status: fields.status ?? 'PAUSED',
        daily_budget: fields.daily_budget ?? '0',
      });
      return json(200, { id });
    }
    if (edge === 'adimages') {
      return json(200, { images: { [fields.name ?? 'image']: { hash: `hash-${newId()}` } } });
    }
    // Like Meta: a validate-only ad is judged and never created.
    if (edge === 'ads' && (fields.execution_options ?? '').includes('validate_only')) {
      return json(200, { success: true });
    }
    const id = newId();
    if (edge === 'adsets' || edge === 'ads') {
      state.objects.set(id, { edge, status: fields.status ?? 'PAUSED' });
    }
    return json(200, { id });
  }

  const impl = (async (url: unknown, init?: RequestInit) => {
    const parsed = new URL(String(url));
    // A video still lives on Meta's CDN, not on the Graph API: bytes come back.
    if (parsed.hostname.endsWith('fbcdn.net')) {
      calls.push({ method: 'GET', path: parsed.pathname, query: {}, fields: {}, headers: {} });
      return new Response(Buffer.from('jpeg-bytes'), { status: 200 });
    }
    const path = parsed.pathname.replace(/^\/v[\d.]+\//, '');
    const query = Object.fromEntries(parsed.searchParams.entries());
    const method = init?.method ?? 'GET';
    const fields = await fieldsOf(init);
    calls.push({
      method,
      path,
      query,
      fields,
      headers: Object.fromEntries(
        Object.entries((init?.headers ?? {}) as Record<string, string>).map(([key, value]) => [
          key.toLowerCase(),
          value,
        ]),
      ),
    });

    if (method === 'GET') return get(path, query);

    const edge = path.split('/')[1] as MetaEdge;
    if (state.failOn && state.failOn.edge === edge && state.failOn.mode === 'network_failure') {
      throw new TypeError('fetch failed');
    }
    const response = post(path, fields);
    if (edge === 'advideos' && fields.upload_phase === 'start' && response.ok) {
      const body = (await response.clone().json()) as { video_id: string; __size: number };
      sizes.set(body.video_id, body.__size);
    }
    return response;
  }) as typeof fetch;

  return {
    impl,
    calls,
    state,
    accountId,
    writes: (edge?: MetaEdge) =>
      calls.filter(
        (call) => call.method === 'POST' && (edge === undefined || call.path.endsWith(`/${edge}`)),
      ),
  };
}
