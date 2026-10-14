import { ALL_SUBMODULES, LEGACY_REDIRECTS } from '@wings/shared';
import { createBrowserRouter, Navigate, Outlet, type RouteObject } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { LegacyRedirect } from './components/LegacyRedirect.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { NoAccess, RequireSubmodule } from './components/RequirePermission.js';
import { RouteError } from './components/RouteError.js';
import { AgendaPage } from './pages/AgendaPage.js';
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
import { HomePage } from './pages/HomePage.js';
import { IntegrationsPage } from './pages/IntegrationsPage.js';
import { LandingRoute } from './pages/LandingRoute.js';
import { LandingPagesPage } from './pages/LandingPagesPage.js';
import { CompaniesPage } from './pages/crm/CompaniesPage.js';
import { ContactsPage } from './pages/crm/ContactsPage.js';
import { CrmSettingsPage } from './pages/crm/CrmSettingsPage.js';
import { AutomationsPage } from './pages/crm/AutomationsPage.js';
import { NotificationsPage } from './pages/crm/NotificationsPage.js';
import { DealPage } from './pages/crm/DealPage.js';
import { DealWhatsAppPage } from './pages/crm/DealWhatsAppPage.js';
import { WhatsAppInboxPage, WhatsAppWaitingPage } from './pages/crm/WhatsAppInboxPage.js';
import { SofiaPage } from './pages/crm/SofiaPage.js';
import { DealsPage } from './pages/crm/DealsPage.js';
import { TasksPage } from './pages/crm/TasksPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { MyAccountPage } from './pages/MyAccountPage.js';
import { CampaignLeadsPage } from './pages/CampaignLeadsPage.js';
import { MarketingDashboardPage } from './pages/MarketingDashboardPage.js';
import { SalesDashboardPage } from './pages/SalesDashboardPage.js';
import { MediaStudioPage } from './pages/MediaStudioPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { OfficePage } from './pages/OfficePage.js';
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
  '/inicio': [{ index: true, element: <HomePage /> }],
  '/crm-vendas/landing-pages': [{ index: true, element: <LandingPagesPage /> }],
  '/crm-vendas/negociacoes': [
    { index: true, element: <DealsPage /> },
    { path: ':id', element: <DealPage /> },
    { path: ':id/whatsapp', element: <DealWhatsAppPage /> },
  ],
  '/crm-vendas/whatsapp': [
    { index: true, element: <WhatsAppInboxPage /> },
    { path: ':id', element: <WhatsAppWaitingPage /> },
  ],
  '/crm-vendas/sofia': [
    { index: true, element: <SofiaPage /> },
    { path: ':id', element: <SofiaPage /> },
  ],
  '/crm-vendas/contatos': [
    { index: true, element: <ContactsPage /> },
    { path: ':id', element: <ContactsPage /> },
  ],
  '/crm-vendas/empresas': [
    { index: true, element: <CompaniesPage /> },
    { path: ':id', element: <CompaniesPage /> },
  ],
  '/crm-vendas/tarefas': [{ index: true, element: <TasksPage /> }],
  '/crm-vendas/avisos': [{ index: true, element: <NotificationsPage /> }],
  '/crm-vendas/configuracoes': [
    { index: true, element: <CrmSettingsPage /> },
    { path: 'automacoes/:pipeline', element: <AutomationsPage /> },
  ],
  '/administracao/drive': [{ index: true, element: <DriveTemplatePage /> }],
  '/drive/arquivos': [{ index: true, element: <DrivePage /> }],
  '/gestao/projetos': [{ index: true, element: <ProjectsPage /> }],
  '/administracao/integracoes': [{ index: true, element: <IntegrationsPage /> }],
  '/dashboard/vendas': [{ index: true, element: <SalesDashboardPage /> }],
  '/dashboard/marketing': [{ index: true, element: <MarketingDashboardPage /> }],
  '/dashboard/leads-campanhas': [{ index: true, element: <CampaignLeadsPage /> }],
  // The sellers' copies inside CRM Vendas (Eric, 14/10): the same pages, at the CRM's address.
  '/crm-vendas/painel-de-vendas': [{ index: true, element: <SalesDashboardPage /> }],
  '/crm-vendas/projetos': [{ index: true, element: <ProjectsPage /> }],
  '/crm-vendas/leads-campanhas': [{ index: true, element: <CampaignLeadsPage /> }],
  // Agenda (Eric, 14/10): one page, the sellers' address inside CRM Vendas and everyone else's.
  '/crm-vendas/agenda': [{ index: true, element: <AgendaPage /> }],
  '/produtividade/agenda': [{ index: true, element: <AgendaPage /> }],
  '/marketing/edicao': [{ index: true, element: <MediaStudioPage /> }],
  '/laboratorio/escritorio': [{ index: true, element: <OfficePage /> }],
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
      errorElement: <RouteError />,
      element: (
        <RequireSubmodule submodule={submodule}>
          <ModuleOutlet />
        </RequireSubmodule>
      ),
      children,
    };
  });
}

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage />, errorElement: <RouteError /> },
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
    // A screen that fails to render shows the error inside the shell (each
    // sub-module has its own errorElement); this one catches what escapes.
    errorElement: <RouteError />,
    children: [
      { index: true, element: <LandingRoute /> },
      { path: 'sem-acesso', element: <NoAccess /> },
      // The person's own connections (Google): any login, no permission.
      { path: 'minha-conta', element: <MyAccountPage />, errorElement: <RouteError /> },
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
  { path: '*', element: <NotFoundPage />, errorElement: <RouteError /> },
]);
