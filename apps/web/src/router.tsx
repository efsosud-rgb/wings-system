import { ALL_SUBMODULES, LEGACY_REDIRECTS } from '@wings/shared';
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { LegacyRedirect } from './components/LegacyRedirect.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { NoAccess, RequirePermission } from './components/RequirePermission.js';
import { ApprovalDetailPage } from './pages/ApprovalDetailPage.js';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { ClientRecordPage } from './pages/ClientRecordPage.js';
import { ClientsPage } from './pages/ClientsPage.js';
import { ComingSoonPage } from './pages/ComingSoonPage.js';
import { DrivePage } from './pages/DrivePage.js';
import { DriveTemplatePage } from './pages/DriveTemplatePage.js';
import { EmployeeFormPage } from './pages/EmployeeFormPage.js';
import { EmployeesPage } from './pages/EmployeesPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { IntegrationsPage } from './pages/IntegrationsPage.js';
import { LandingRoute } from './pages/LandingRoute.js';
import { LeadPage } from './pages/LeadPage.js';
import { LandingPagesPage } from './pages/LandingPagesPage.js';
import { LeadsPage } from './pages/LeadsPage.js';
import { TasksPage } from './pages/TasksPage.js';
import { CrmSettingsPage } from './pages/CrmSettingsPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { CampaignLeadsPage } from './pages/CampaignLeadsPage.js';
import { MarketingDashboardPage } from './pages/MarketingDashboardPage.js';
import { MediaStudioPage } from './pages/MediaStudioPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { RoadmapPage } from './pages/RoadmapPage.js';
import { SetPasswordPage } from './pages/SetPasswordPage.js';
import { SiteFormPage } from './pages/SiteFormPage.js';
import { TrafficStudioPage } from './pages/TrafficStudioPage.js';

/**
 * Routes, generated from the same navigation tree that builds the menu.
 *
 * Every sub-module gets a route automatically; the handful with real screens
 * are listed below and everything else falls to the placeholder. That makes it
 * impossible to ship a menu entry with no route, which is what produced the
 * dead `/ponto` and `/configuracoes` links.
 *
 * The screens themselves did not change in Phase 0: the cockpit, the employee
 * list and the approvals panel are the same components at new addresses.
 */

/** Renders whichever child route matched, beneath its permission gate. */
function ModuleOutlet() {
  return <Outlet />;
}

/** Screens that exist, by sub-module path. Anything absent is "em breve". */
const SCREENS: Record<string, RouteObject[]> = {
  '/administracao/usuarios': [
    { index: true, element: <EmployeesPage /> },
    { path: 'novo', element: <EmployeeFormPage /> },
    { path: ':id', element: <EmployeeFormPage /> },
  ],
  '/administracao/roadmap': [
    { index: true, element: <RoadmapPage /> },
    { path: 'relatorios/:id', element: <RoadmapPage /> },
  ],
  '/formatacao/clientes': [
    { index: true, element: <ClientsPage /> },
    { path: ':id', element: <ClientRecordPage /> },
  ],
  '/crm-vendas/landing-pages': [{ index: true, element: <LandingPagesPage /> }],
  '/crm-vendas/funil': [
    { index: true, element: <LeadsPage /> },
    { path: ':id', element: <LeadPage /> },
  ],
  '/crm-vendas/tarefas': [{ index: true, element: <TasksPage /> }],
  '/administracao/crm': [{ index: true, element: <CrmSettingsPage /> }],
  '/administracao/drive': [{ index: true, element: <DriveTemplatePage /> }],
  '/drive/arquivos': [{ index: true, element: <DrivePage /> }],
  '/gestao/projetos': [{ index: true, element: <ProjectsPage /> }],
  '/administracao/integracoes': [{ index: true, element: <IntegrationsPage /> }],
  '/dashboard/marketing': [{ index: true, element: <MarketingDashboardPage /> }],
  '/dashboard/leads-campanhas': [{ index: true, element: <CampaignLeadsPage /> }],
  '/marketing/edicao': [{ index: true, element: <MediaStudioPage /> }],
  '/marketing/trafego-pago-wings': [
    { index: true, element: <TrafficStudioPage /> },
    { path: 'aprovacoes', element: <ApprovalsPage /> },
    { path: 'aprovacoes/:id', element: <ApprovalDetailPage /> },
  ],
};

function submoduleRoutes(): RouteObject[] {
  return ALL_SUBMODULES.map((submodule) => {
    const children = SCREENS[submodule.path] ?? [{ index: true, element: <ComingSoonPage /> }];
    // Leading slash removed: these are children of the authenticated shell.
    const path = submodule.path.replace(/^\//, '');

    return {
      path,
      element: submodule.permission ? (
        <RequirePermission permission={submodule.permission}>
          <ModuleOutlet />
        </RequirePermission>
      ) : (
        <ModuleOutlet />
      ),
      children,
    };
  });
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/esqueci-senha', element: <ForgotPasswordPage /> },
  // Invite and reset links land here; both post to the same endpoint.
  { path: '/definir-senha', element: <SetPasswordPage mode="invite" /> },
  { path: '/redefinir-senha', element: <SetPasswordPage mode="reset" /> },
  // Public: a landing page's own form (CRM phase 1, T5); no session.
  { path: '/lp/:slug', element: <SiteFormPage /> },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <LandingRoute /> },
      { path: 'sem-acesso', element: <NoAccess /> },
      ...submoduleRoutes(),
      // Screens that moved in Phase 0. Links already sent cannot be edited —
      // the WhatsApp approval link points at the old path, and a 404 there
      // once cost us a stage — so the old addresses keep working, sub-paths
      // included (`/trafego-pago/aprovacoes/<id>`).
      ...LEGACY_REDIRECTS.map((redirect) => ({
        path: `${redirect.from.replace(/^\//, '')}/*`,
        element: <LegacyRedirect from={redirect.from} to={redirect.to} />,
      })),
      ...LEGACY_REDIRECTS.map((redirect) => ({
        path: redirect.from.replace(/^\//, ''),
        element: <Navigate to={redirect.to} replace />,
      })),
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
