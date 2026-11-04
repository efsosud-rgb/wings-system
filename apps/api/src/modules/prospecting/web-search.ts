import { shapeOf } from '../media/kairogen-adapter.js';

/**
 * The web search of the Instagram finder's last path (t086): Brave Search, the provider the
 * worker already uses for the lead research (`BRAVE_SEARCH_API_KEY`). PAID per query (US$ 5 per
 * 1,000), so each call is reserved against a daily ceiling before it goes (instagram-finder.ts).
 * The key goes in a header, never in a URL; the log carries the answer's shape only, since the
 * query holds a company's name.
 *
 * NOT verified live: the response follows Brave's reference, as the worker's client does.
 */

export interface WebResult {
  title: string;
  url: string;
}

export interface WebSearchClient {
  /**
   * One call, never retried: it is billed even when it fails. Rejects when the answer cannot be
   * read: an unreadable answer is a failed search, never "no result" (lição 4).
   */
  search(query: string): Promise<WebResult[]>;
}

export function createWebSearch(config: {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (facts: Record<string, unknown>) => void;
}): WebSearchClient {
  const fetchImpl = config.fetchImpl ?? fetch;
  return {
    async search(query) {
      const url = new URL(`${config.baseUrl ?? 'https://api.search.brave.com'}/res/v1/web/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('count', '10');
      url.searchParams.set('country', 'BR');
      url.searchParams.set('search_lang', 'pt-br');
      const response = await fetchImpl(url, {
        headers: { 'X-Subscription-Token': config.apiKey, Accept: 'application/json' },
        signal: AbortSignal.timeout(config.timeoutMs ?? 10_000),
      });
      if (!response.ok) throw new Error(`Web search answered ${response.status}`);
      let body: { web?: { results?: unknown } };
      try {
        body = (await response.json()) as typeof body;
      } catch {
        throw new Error('Web search answered with no readable JSON');
      }
      config.log?.({ module: 'web-search', shape: shapeOf(body) });
      const results = Array.isArray(body.web?.results) ? body.web.results : [];
      return (results as Record<string, unknown>[])
        .map((result) => ({
          title: typeof result.title === 'string' ? result.title : '',
          url: typeof result.url === 'string' ? result.url : '',
        }))
        .filter((result) => result.url !== '');
    },
  };
}
