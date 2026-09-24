/**
 * Minimal GitHub REST client for the roadmap's commit-history generator
 * (docs/roadmap.md).
 *
 * Read-only: it lists commits on a branch and, for each one, the files it
 * touched. No PRs, no issues, no writes — the generator groups by path, not
 * by pull request, because this repo's flow lands work on `develop` directly.
 * Mirrors `lib/zapi.ts`'s shape: typed config, no retries beyond a single
 * timeout, and errors that never echo the token or a request URL.
 */

export interface GithubRepoHistoryConfig {
  /** A GitHub PAT (fine-grained, read-only, Contents+Metadata on this repo). */
  token: string;
  /** `owner/repo`. */
  repo: string;
  /** Override for tests; defaults to the public API. */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface GithubCommitSummary {
  sha: string;
  message: string;
  /** ISO 8601, the commit author's date. */
  authorDate: string;
}

export interface GithubCommitFile {
  filename: string;
  additions: number;
  deletions: number;
  changes: number;
}

export interface GithubCommitDetail extends GithubCommitSummary {
  files: GithubCommitFile[];
}

export class GithubRepoHistoryError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'GithubRepoHistoryError';
    this.status = status;
  }
}

interface CommitListEntry {
  sha: string;
  commit?: { message?: string; author?: { date?: string } | null };
}

interface CommitDetailResponse {
  sha: string;
  commit?: { message?: string; author?: { date?: string } | null };
  files?: { filename?: string; additions?: number; deletions?: number; changes?: number }[];
}

export class GithubRepoHistoryClient {
  private readonly config: Required<Omit<GithubRepoHistoryConfig, 'fetchImpl'>> & {
    fetchImpl: typeof fetch;
  };

  constructor(config: GithubRepoHistoryConfig) {
    if (!config.token) throw new Error('GitHub roadmap client requires a token');
    if (!/^[^/\s]+\/[^/\s]+$/.test(config.repo)) {
      throw new Error('GitHub roadmap client requires "owner/repo"');
    }
    this.config = {
      token: config.token,
      repo: config.repo,
      baseUrl: config.baseUrl ?? 'https://api.github.com',
      timeoutMs: config.timeoutMs ?? 15_000,
      fetchImpl: config.fetchImpl ?? fetch,
    };
  }

  private async get(path: string): Promise<unknown> {
    // The path may carry a query string; never logged with the token, which
    // travels only in the Authorization header.
    const url = `${this.config.baseUrl}${path}`;
    let response: Response;
    try {
      response = await this.config.fetchImpl(url, {
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
          'User-Agent': 'wings-system-roadmap',
        },
        signal: AbortSignal.timeout(this.config.timeoutMs),
      });
    } catch (error) {
      throw new GithubRepoHistoryError(
        0,
        `transport failure: ${error instanceof Error ? error.name : 'unknown'}`,
      );
    }
    if (!response.ok) {
      throw new GithubRepoHistoryError(response.status, `GitHub answered ${response.status}`);
    }
    return response.json();
  }

  /**
   * Every commit on `branch`, oldest last (GitHub's own order), across as
   * many pages as needed. `maxPages` guards against pulling a repo's entire
   * history by accident.
   */
  async listCommits(
    branch: string,
    options: { since?: string; perPage?: number; maxPages?: number } = {},
  ): Promise<GithubCommitSummary[]> {
    const perPage = options.perPage ?? 100;
    const maxPages = options.maxPages ?? 10;
    const commits: GithubCommitSummary[] = [];
    for (let page = 1; page <= maxPages; page += 1) {
      const params = new URLSearchParams({
        sha: branch,
        per_page: String(perPage),
        page: String(page),
      });
      if (options.since) params.set('since', options.since);
      const body = (await this.get(
        `/repos/${this.config.repo}/commits?${params.toString()}`,
      )) as CommitListEntry[];
      for (const entry of body) {
        commits.push({
          sha: entry.sha,
          message: entry.commit?.message ?? '',
          authorDate: entry.commit?.author?.date ?? '',
        });
      }
      if (body.length < perPage) break;
    }
    return commits;
  }

  /** One commit's changed files, with lines added/removed. */
  async commitDetail(sha: string): Promise<GithubCommitDetail> {
    const body = (await this.get(
      `/repos/${this.config.repo}/commits/${sha}`,
    )) as CommitDetailResponse;
    return {
      sha: body.sha,
      message: body.commit?.message ?? '',
      authorDate: body.commit?.author?.date ?? '',
      files: (body.files ?? []).map((file) => ({
        filename: file.filename ?? '',
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        changes: file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0),
      })),
    };
  }
}
