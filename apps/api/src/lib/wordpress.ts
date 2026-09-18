/**
 * WordPress REST client for Wings' own site.
 *
 * It can do exactly one thing: create a **draft** post. `status` is not a
 * parameter — it is the literal 'draft' below — so no caller, bug or agent can
 * put something on the public site through this class. Publishing is a person
 * pressing the button inside WordPress. It never edits or deletes anything.
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

  async createDraftPost(input: {
    title: string;
    excerpt: string;
    contentHtml: string;
  }): Promise<DraftOutcome> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.root}/wp-json/wp/v2/posts`, {
        method: 'POST',
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: input.title,
          excerpt: input.excerpt,
          content: input.contentHtml,
          status: 'draft',
        }),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      return {
        status: 'unknown',
        reason: `transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
      };
    }

    const text = await response.text();
    let body: { id?: unknown; status?: unknown; code?: unknown; message?: unknown } = {};
    try {
      body = JSON.parse(text) as typeof body;
    } catch {
      // Not JSON: a proxy error page, or a site without the REST API.
    }

    if (response.status >= 500)
      return { status: 'unknown', reason: `site error ${response.status}` };
    if (!response.ok) {
      return {
        status: 'failed',
        code: typeof body.code === 'string' ? body.code : String(response.status),
        message:
          typeof body.message === 'string'
            ? body.message
            : `WordPress respondeu ${response.status}`,
      };
    }
    if (typeof body.id !== 'number') {
      return { status: 'unknown', reason: 'the site answered without a post id' };
    }
    return {
      status: 'draft_created',
      postId: body.id,
      editUrl: `${this.root}/wp-admin/post.php?post=${body.id}&action=edit`,
    };
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Plain text to paragraphs. Everything is escaped: the operator sends no markup. */
export function plainTextToHtml(text: string): string {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter((block) => block !== '')
    .map((block) => `<p>${escapeHtml(block).replace(/\n/g, '<br />')}</p>`)
    .join('\n');
}
