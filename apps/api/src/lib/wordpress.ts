/**
 * WordPress REST client for Wings' own site.
 *
 * What it can do is the whole of what the studio may do to the public site:
 *
 *  - read the site's categories and tags;
 *  - add a NEW item to the media library;
 *  - create a NEW post as a **draft**.
 *
 * `status` is not a parameter — it is the literal 'draft' below — so no caller,
 * bug or agent can put something on the public site through this class. Going
 * live is a person pressing the button inside WordPress. Every write is a POST
 * to a collection (`/posts`, `/media`): there is no method here that takes the
 * id of something already on the site, so nothing existing can be edited,
 * replaced or deleted. It creates no terms either: the site's user is an
 * Author, who cannot, and the studio only offers the terms that exist.
 */

export interface WordPressConfig {
  /** Site root, e.g. https://wingscompany.com.br — https only. */
  baseUrl: string;
  username: string;
  /** A WordPress application password, not the account's login password. */
  applicationPassword: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type DraftOutcome =
  | { status: 'draft_created'; postId: number; editUrl: string }
  | { status: 'failed'; code: string; message: string }
  /** The request may have landed; a person must look before sending again. */
  | { status: 'unknown'; reason: string };

export type MediaOutcome =
  | { status: 'uploaded'; mediaId: number; sourceUrl: string }
  | { status: 'failed'; code: string; message: string }
  | { status: 'unknown'; reason: string };

export interface WordPressTerm {
  id: number;
  name: string;
  count: number;
}

/** A published post as the mirror keeps it: title, dates, link, category ids. */
export interface WordPressPostSummary {
  id: number;
  title: string;
  slug: string;
  link: string;
  /** ISO instants, from the site's GMT fields. */
  publishedAt: string;
  modifiedAt: string | null;
  categoryIds: number[];
}

export interface DraftPostInput {
  title: string;
  excerpt: string;
  contentHtml: string;
  categories?: number[];
  tags?: number[];
  featuredMediaId?: number | null;
}

export interface MediaInput {
  bytes: Buffer;
  mimeType: string;
  /** ASCII file name with extension; it becomes the attachment's slug. */
  filename: string;
  title: string;
  altText: string;
  caption: string;
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Term names arrive HTML-encoded ("Governança &amp; Franchising"). */
export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code =
        body[1]?.toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

interface ErrorBody {
  code?: unknown;
  message?: unknown;
}

export class WordPressClient {
  readonly siteHost: string;
  private readonly root: string;
  private readonly authorization: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(config: WordPressConfig) {
    const url = new URL(config.baseUrl);
    // Basic auth over plain http would send the password in the clear.
    if (url.protocol !== 'https:') throw new Error('WORDPRESS_BASE_URL must be https');
    this.siteHost = url.host;
    this.root = `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
    this.authorization = `Basic ${Buffer.from(
      `${config.username}:${config.applicationPassword}`,
    ).toString('base64')}`;
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.timeoutMs = config.timeoutMs ?? 15_000;
  }

  /** Every category or tag on the site, following pagination. Read-only. */
  private async listTerms(taxonomy: 'categories' | 'tags'): Promise<WordPressTerm[]> {
    const terms: WordPressTerm[] = [];
    // 100 is the API's maximum page size; ten pages is far beyond this site.
    for (let page = 1; page <= 10; page += 1) {
      const response = await this.fetchImpl(
        `${this.root}/wp-json/wp/v2/${taxonomy}?per_page=100&page=${page}&orderby=name&_fields=id,name,count`,
        {
          headers: { Authorization: this.authorization },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok)
        throw new Error(`WordPress answered ${response.status} listing ${taxonomy}`);
      const body = (await response.json()) as { id?: unknown; name?: unknown; count?: unknown }[];
      for (const term of body) {
        if (typeof term.id === 'number' && typeof term.name === 'string') {
          terms.push({
            id: term.id,
            name: decodeEntities(term.name),
            count: typeof term.count === 'number' ? term.count : 0,
          });
        }
      }
      const pages = Number(response.headers.get('x-wp-totalpages') ?? '1');
      if (page >= pages || body.length === 0) break;
    }
    return terms;
  }

  listCategories(): Promise<WordPressTerm[]> {
    return this.listTerms('categories');
  }

  listTags(): Promise<WordPressTerm[]> {
    return this.listTerms('tags');
  }

  /**
   * Every published post, newest first, following pagination. Read-only, and
   * only the fields the dashboard lists: never the content. NOT verified live:
   * that `date_gmt`/`modified_gmt` come with `_fields` on this site.
   */
  async listPublishedPosts(
    options: { modifiedAfter?: string } = {},
  ): Promise<WordPressPostSummary[]> {
    const posts: WordPressPostSummary[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const query = new URLSearchParams({
        status: 'publish',
        per_page: '100',
        page: String(page),
        orderby: 'date',
        order: 'desc',
        _fields: 'id,date_gmt,modified_gmt,title,link,slug,categories',
      });
      if (options.modifiedAfter) query.set('modified_after', options.modifiedAfter);
      const response = await this.fetchImpl(
        `${this.root}/wp-json/wp/v2/posts?${query.toString()}`,
        {
          headers: { Authorization: this.authorization },
          signal: AbortSignal.timeout(this.timeoutMs),
        },
      );
      if (!response.ok) throw new Error(`WordPress answered ${response.status} listing posts`);
      const body = (await response.json()) as {
        id?: unknown;
        date_gmt?: unknown;
        modified_gmt?: unknown;
        title?: { rendered?: unknown };
        link?: unknown;
        slug?: unknown;
        categories?: unknown;
      }[];
      for (const post of body) {
        if (typeof post.id !== 'number' || typeof post.date_gmt !== 'string') continue;
        const published = new Date(`${post.date_gmt}Z`);
        if (Number.isNaN(published.getTime())) continue;
        const modified =
          typeof post.modified_gmt === 'string' ? new Date(`${post.modified_gmt}Z`) : null;
        posts.push({
          id: post.id,
          title: decodeEntities(
            typeof post.title?.rendered === 'string' ? post.title.rendered : '',
          ),
          slug: typeof post.slug === 'string' ? post.slug : '',
          link: typeof post.link === 'string' ? post.link : '',
          publishedAt: published.toISOString(),
          modifiedAt: modified && !Number.isNaN(modified.getTime()) ? modified.toISOString() : null,
          categoryIds: Array.isArray(post.categories)
            ? post.categories.filter((id): id is number => typeof id === 'number')
            : [],
        });
      }
      const pages = Number(response.headers.get('x-wp-totalpages') ?? '1');
      if (page >= pages || body.length === 0) break;
    }
    return posts;
  }

  /** POSTs and sorts the answer into created / refused / don't know. */
  private async post(
    path: string,
    init: { headers: Record<string, string>; body: string | Buffer },
    timeoutMs: number,
  ): Promise<
    | { ok: true; body: Record<string, unknown> }
    | {
        ok: false;
        outcome:
          | { status: 'failed'; code: string; message: string }
          | { status: 'unknown'; reason: string };
      }
  > {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.root}/wp-json/wp/v2/${path}`, {
        method: 'POST',
        headers: { Authorization: this.authorization, ...init.headers },
        body: init.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      return {
        ok: false,
        outcome: {
          status: 'unknown',
          reason: `transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
        },
      };
    }

    const text = await response.text();
    let body: Record<string, unknown> & ErrorBody = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // Not JSON: a proxy error page, or a site without the REST API.
    }

    if (response.status >= 500) {
      return { ok: false, outcome: { status: 'unknown', reason: `site error ${response.status}` } };
    }
    if (!response.ok) {
      return {
        ok: false,
        outcome: {
          status: 'failed',
          code: typeof body.code === 'string' ? body.code : String(response.status),
          message:
            typeof body.message === 'string'
              ? body.message
              : `WordPress respondeu ${response.status}`,
        },
      };
    }
    return { ok: true, body };
  }

  /** Adds ONE new item to the media library. Never touches an existing one. */
  async uploadMedia(input: MediaInput): Promise<MediaOutcome> {
    const query = new URLSearchParams({
      title: input.title,
      alt_text: input.altText,
      caption: input.caption,
    });
    const result = await this.post(
      `media?${query.toString()}`,
      {
        headers: {
          'Content-Type': input.mimeType,
          'Content-Disposition': `attachment; filename="${input.filename.replace(/[^A-Za-z0-9._-]/g, '')}"`,
        },
        body: input.bytes,
      },
      // A 5 MB image over a shared host takes longer than a JSON post.
      Math.max(this.timeoutMs, 60_000),
    );
    if (!result.ok) return result.outcome;

    const { id, source_url: sourceUrl } = result.body;
    if (typeof id !== 'number' || typeof sourceUrl !== 'string') {
      return { status: 'unknown', reason: 'the site answered without a media id' };
    }
    return { status: 'uploaded', mediaId: id, sourceUrl };
  }

  async createDraftPost(input: DraftPostInput): Promise<DraftOutcome> {
    const result = await this.post(
      'posts',
      {
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          excerpt: input.excerpt,
          content: input.contentHtml,
          status: 'draft',
          ...(input.categories?.length ? { categories: input.categories } : {}),
          ...(input.tags?.length ? { tags: input.tags } : {}),
          ...(input.featuredMediaId ? { featured_media: input.featuredMediaId } : {}),
        }),
      },
      this.timeoutMs,
    );
    if (!result.ok) return result.outcome;

    const { id } = result.body;
    if (typeof id !== 'number') {
      return { status: 'unknown', reason: 'the site answered without a post id' };
    }
    return {
      status: 'draft_created',
      postId: id,
      editUrl: `${this.root}/wp-admin/post.php?post=${id}&action=edit`,
    };
  }
}
