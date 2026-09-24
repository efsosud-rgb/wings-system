import { NAVIGATION, type RoadmapDeliverableStatus, type RoadmapWeight } from '@wings/shared';
import type { GithubCommitDetail, GithubCommitSummary } from '../../lib/github-repo-history.js';

/**
 * First-version roadmap generator: walks commits on `develop` (where this
 * repo's flow lands work first) and groups the files each one touched by the
 * navigation submodule they belong to, so a deliverable's progress reads
 * straight off what has actually shipped.
 *
 * `navigation.ts` is the authority for which submodules exist, their labels
 * and their `coming_soon` status. English `apps/api/src/modules/<name>`
 * folder names don't literally match the Portuguese routes in `navigation.ts`
 * though, so the two lookup tables below name that connection by hand; they
 * need a one-line update when a module or a screen moves.
 */

export interface CommitReader {
  listCommits(
    branch: string,
    options?: { since?: string; perPage?: number; maxPages?: number },
  ): Promise<GithubCommitSummary[]>;
  commitDetail(sha: string): Promise<GithubCommitDetail>;
}

/** `apps/api/src/modules/<name>` -> the submodule path it mainly serves. */
const API_MODULE_SUBMODULE: Record<string, string> = {
  auth: '/administracao/usuarios',
  employees: '/administracao/usuarios',
  ads: '/marketing/trafego-pago-wings',
  agent: '/marketing/trafego-pago-wings',
  clients: '/administracao/clientes',
  drive: '/administracao/drive',
  leads: '/crm-vendas/funil',
  media: '/marketing/edicao',
  studio: '/marketing/edicao',
  projects: '/gestao/projetos',
  insights: '/dashboard/marketing',
  integrations: '/administracao/integracoes',
  timeclock: '/gestao/rh-dp',
  site: '/marketing/edicao',
  roadmap: '/administracao/roadmap',
};

/** `apps/web/src/pages/<Component>.tsx` -> the submodule path it renders (mirrors router.tsx's SCREENS map). */
const WEB_PAGE_SUBMODULE: Record<string, string> = {
  EmployeesPage: '/administracao/usuarios',
  EmployeeFormPage: '/administracao/usuarios',
  ClientsPage: '/administracao/clientes',
  LeadsPage: '/crm-vendas/funil',
  LeadPage: '/crm-vendas/funil',
  DriveTemplatePage: '/administracao/drive',
  DrivePage: '/drive/arquivos',
  ProjectsPage: '/gestao/projetos',
  IntegrationsPage: '/administracao/integracoes',
  MarketingDashboardPage: '/dashboard/marketing',
  MediaStudioPage: '/marketing/edicao',
  TrafficStudioPage: '/marketing/trafego-pago-wings',
  ApprovalsPage: '/marketing/trafego-pago-wings',
  ApprovalDetailPage: '/marketing/trafego-pago-wings',
};

/** `docs/<topic>/...` or `docs/<topic>.md` -> the submodule path, when the topic name differs from an API module name. */
const DOC_TOPIC_SUBMODULE: Record<string, string> = {
  integracoes: '/administracao/integracoes',
  projetos: '/gestao/projetos',
};

function submodulePathForFile(path: string): string | null {
  const segments = path.split('/');
  if (segments[0] === 'apps' && segments[1] === 'api' && segments[2] === 'src' && segments[3] === 'modules') {
    const name = segments[4];
    return (name && API_MODULE_SUBMODULE[name]) || null;
  }
  if (segments[0] === 'apps' && segments[1] === 'web' && segments[2] === 'src' && segments[3] === 'pages') {
    const component = (segments[4] ?? '').replace(/\.(tsx|ts)$/, '');
    return WEB_PAGE_SUBMODULE[component] || null;
  }
  if (segments[0] === 'docs') {
    const topic = (segments.length > 2 ? segments[1] : segments[1]?.replace(/\.md$/, '')) ?? '';
    return DOC_TOPIC_SUBMODULE[topic] || API_MODULE_SUBMODULE[topic] || null;
  }
  return null;
}

/** Small (<100 lines) is P, medium (<400) is M, else G. */
export function weightFromLinesChanged(totalChanges: number): RoadmapWeight {
  if (totalChanges < 100) return 'P';
  if (totalChanges < 400) return 'M';
  return 'G';
}

export interface GeneratedDeliverable {
  /** The submodule path from navigation.ts — identifies the deliverable across generator runs. */
  submodulePath: string;
  moduleKey: string;
  moduleLabel: string;
  label: string;
  weight: RoadmapWeight;
  status: RoadmapDeliverableStatus;
  /** YYYY-MM-DD, or null when there is no commit evidence to date it. */
  completedAt: string | null;
}

export interface GeneratedModule {
  key: string;
  label: string;
  position: number;
  isComingSoon: boolean;
}

export interface GeneratedRoadmap {
  modules: GeneratedModule[];
  deliverables: GeneratedDeliverable[];
}

interface PathStat {
  totalChanges: number;
  /** The latest commit touching this path: best-effort completion date — see module doc. */
  latestDate: Date;
}

/**
 * Walks every commit on `branch`, attributes each changed file's line count
 * to the submodule it belongs to, and turns that into one deliverable per
 * submodule in `navigation.ts`.
 *
 * "Completed" date: with no PR merge boundary in this repo's flow (commits
 * land straight on develop), the most defensible single moment for "when did
 * this ship" is the latest commit that touched the submodule's paths — not
 * the first, which would date a feature to when it was *started*.
 */
export async function generateRoadmap(
  reader: CommitReader,
  options: { branch?: string } = {},
): Promise<GeneratedRoadmap> {
  const branch = options.branch ?? 'develop';
  const commits = await reader.listCommits(branch);

  const stats = new Map<string, PathStat>();
  for (const commit of commits) {
    const detail = await reader.commitDetail(commit.sha);
    const commitDate = detail.authorDate ? new Date(detail.authorDate) : null;
    for (const file of detail.files) {
      const submodulePath = submodulePathForFile(file.filename);
      if (!submodulePath) continue;
      const existing = stats.get(submodulePath);
      if (!existing) {
        stats.set(submodulePath, {
          totalChanges: file.changes,
          latestDate: commitDate ?? new Date(0),
        });
      } else {
        existing.totalChanges += file.changes;
        if (commitDate && commitDate.getTime() > existing.latestDate.getTime()) {
          existing.latestDate = commitDate;
        }
      }
    }
  }

  const modules: GeneratedModule[] = [];
  const deliverables: GeneratedDeliverable[] = [];

  NAVIGATION.forEach((navModule, index) => {
    modules.push({
      key: navModule.key,
      label: navModule.label,
      position: index,
      isComingSoon: navModule.submodules.every((submodule) => submodule.status === 'coming_soon'),
    });

    for (const submodule of navModule.submodules) {
      if (submodule.status === 'coming_soon') {
        deliverables.push({
          submodulePath: submodule.path,
          moduleKey: navModule.key,
          moduleLabel: navModule.label,
          label: submodule.label,
          // No commits exist to size a not-yet-built submodule; M is a
          // neutral placeholder weight until someone scopes it by hand.
          weight: 'M',
          status: 'pendente',
          completedAt: null,
        });
        continue;
      }

      const stat = stats.get(submodule.path);
      if (stat) {
        deliverables.push({
          submodulePath: submodule.path,
          moduleKey: navModule.key,
          moduleLabel: navModule.label,
          label: submodule.label,
          weight: weightFromLinesChanged(stat.totalChanges),
          status: 'pronto',
          completedAt: stat.latestDate.toISOString().slice(0, 10),
        });
      } else {
        // `status: 'ready'` in navigation.ts already means the submodule has
        // a screen and a backend; a gap in the path tables above must never
        // demote it to pendente. It still counts pronto, just with no size
        // signal (a neutral M) and no completion date (unknown).
        deliverables.push({
          submodulePath: submodule.path,
          moduleKey: navModule.key,
          moduleLabel: navModule.label,
          label: submodule.label,
          weight: 'M',
          status: 'pronto',
          completedAt: null,
        });
      }
    }
  });

  return { modules, deliverables };
}
