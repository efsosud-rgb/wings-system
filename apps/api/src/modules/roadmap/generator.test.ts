import { ALL_SUBMODULES } from '@wings/shared';
import { describe, expect, it } from 'vitest';
import type { GithubCommitDetail, GithubCommitSummary } from '../../lib/github-repo-history.js';
import { generateRoadmap, weightFromLinesChanged, type CommitReader } from './generator.js';

function fakeReader(
  commits: (GithubCommitSummary & { files: GithubCommitDetail['files'] })[],
): CommitReader {
  return {
    async listCommits() {
      return commits.map(({ sha, message, authorDate }) => ({ sha, message, authorDate }));
    },
    async commitDetail(sha) {
      const commit = commits.find((c) => c.sha === sha);
      if (!commit) throw new Error(`no fixture for ${sha}`);
      return commit;
    },
  };
}

describe('weightFromLinesChanged', () => {
  it('is P under 100, M under 400, G otherwise', () => {
    expect(weightFromLinesChanged(0)).toBe('P');
    expect(weightFromLinesChanged(99)).toBe('P');
    expect(weightFromLinesChanged(100)).toBe('M');
    expect(weightFromLinesChanged(399)).toBe('M');
    expect(weightFromLinesChanged(400)).toBe('G');
    expect(weightFromLinesChanged(5000)).toBe('G');
  });
});

describe('generateRoadmap', () => {
  it('never hits the network without a commit reader that resolves', async () => {
    const reader = fakeReader([]);
    const result = await generateRoadmap(reader);
    expect(result.modules.length).toBe(new Set(ALL_SUBMODULES.map((s) => s.moduleKey)).size);
  });

  it('marks a coming_soon submodule pendente with no commits, weight M', async () => {
    const result = await generateRoadmap(fakeReader([]));
    const sofia = result.deliverables.find((d) => d.submodulePath === '/crm-vendas/sofia');
    expect(sofia).toMatchObject({ status: 'pendente', weight: 'M', completedAt: null });
  });

  it("groups a commit that touches an API module folder into that module's submodule", async () => {
    const reader = fakeReader([
      {
        sha: 'a1',
        message: 'feat(leads): funnel',
        authorDate: '2026-09-01T00:00:00Z',
        files: [
          {
            filename: 'apps/api/src/modules/leads/routes.ts',
            additions: 30,
            deletions: 10,
            changes: 40,
          },
        ],
      },
    ]);
    const result = await generateRoadmap(reader);
    const funil = result.deliverables.find((d) => d.submodulePath === '/crm-vendas/funil');
    expect(funil).toMatchObject({ status: 'pronto', weight: 'P', completedAt: '2026-09-01' });
  });

  it('groups a commit that touches a web page into the submodule that page renders', async () => {
    const reader = fakeReader([
      {
        sha: 'b1',
        message: 'feat(web): projects board',
        authorDate: '2026-09-02T00:00:00Z',
        files: [
          {
            filename: 'apps/web/src/pages/ProjectsPage.tsx',
            additions: 200,
            deletions: 50,
            changes: 250,
          },
        ],
      },
    ]);
    const result = await generateRoadmap(reader);
    const projects = result.deliverables.find((d) => d.submodulePath === '/gestao/projetos');
    expect(projects).toMatchObject({ status: 'pronto', weight: 'M', completedAt: '2026-09-02' });
  });

  it('sums lines across multiple commits touching the same submodule and dates it by the latest one', async () => {
    const reader = fakeReader([
      {
        sha: 'c1',
        message: 'feat(drive): first pass',
        authorDate: '2026-08-01T00:00:00Z',
        files: [
          {
            filename: 'apps/api/src/modules/drive/routes.ts',
            additions: 150,
            deletions: 0,
            changes: 150,
          },
        ],
      },
      {
        sha: 'c2',
        message: 'feat(drive): second pass',
        authorDate: '2026-08-15T00:00:00Z',
        files: [
          {
            filename: 'apps/api/src/modules/drive/service.ts',
            additions: 300,
            deletions: 0,
            changes: 300,
          },
        ],
      },
    ]);
    const result = await generateRoadmap(reader);
    const drive = result.deliverables.find((d) => d.submodulePath === '/administracao/drive');
    // 150 + 300 = 450 lines -> G
    expect(drive).toMatchObject({ status: 'pronto', weight: 'G', completedAt: '2026-08-15' });
  });

  it('ignores files outside any known module/page/docs path', async () => {
    const reader = fakeReader([
      {
        sha: 'd1',
        message: 'chore: root config',
        authorDate: '2026-09-03T00:00:00Z',
        files: [{ filename: 'pnpm-lock.yaml', additions: 5000, deletions: 5000, changes: 10000 }],
      },
    ]);
    const result = await generateRoadmap(reader);
    // Nothing should have picked up 10000 lines of changes.
    expect(
      result.deliverables.every((d) => d.weight !== 'G' || d.completedAt !== '2026-09-03'),
    ).toBe(true);
  });

  it('still marks a ready submodule pronto even with a path-table gap, but with no completion date', async () => {
    const result = await generateRoadmap(fakeReader([]));
    const funil = result.deliverables.find((d) => d.submodulePath === '/crm-vendas/funil');
    expect(funil).toMatchObject({ status: 'pronto', weight: 'M', completedAt: null });
  });

  it('marks a whole module coming-soon only when every one of its submodules is', async () => {
    const result = await generateRoadmap(fakeReader([]));
    const contratos = result.modules.find((m) => m.key === 'contratos');
    const marketing = result.modules.find((m) => m.key === 'marketing');
    expect(contratos?.isComingSoon).toBe(true);
    expect(marketing?.isComingSoon).toBe(false);
  });
});
