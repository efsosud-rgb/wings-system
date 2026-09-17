import { createBrowserRouter, Navigate } from 'react-router-dom';
import { AppShell } from './components/AppShell.js';
import { ProtectedRoute } from './components/ProtectedRoute.js';
import { ApprovalDetailPage } from './pages/ApprovalDetailPage.js';
import { ApprovalsPage } from './pages/ApprovalsPage.js';
import { CockpitPage } from './pages/CockpitPage.js';
import { EmployeeFormPage } from './pages/EmployeeFormPage.js';
import { EmployeesPage } from './pages/EmployeesPage.js';
import { ForgotPasswordPage } from './pages/ForgotPasswordPage.js';
import { LoginPage } from './pages/LoginPage.js';
import { NotFoundPage } from './pages/NotFoundPage.js';
import { SetPasswordPage } from './pages/SetPasswordPage.js';

export const router = createBrowserRouter([
  { path: '/login', element: <LoginPage /> },
  { path: '/esqueci-senha', element: <ForgotPasswordPage /> },
  // Invite and reset links land here; both post to the same endpoint.
  { path: '/definir-senha', element: <SetPasswordPage mode="invite" /> },
  { path: '/redefinir-senha', element: <SetPasswordPage mode="reset" /> },
  {
    path: '/',
    element: (
      <ProtectedRoute>
        <AppShell />
      </ProtectedRoute>
    ),
    children: [
      { index: true, element: <Navigate to="/funcionarios" replace /> },
      { path: 'funcionarios', element: <EmployeesPage /> },
      { path: 'funcionarios/novo', element: <EmployeeFormPage /> },
      { path: 'funcionarios/:id', element: <EmployeeFormPage /> },
      { path: 'trafego-pago', element: <CockpitPage /> },
      // Same path the WhatsApp approval link points at.
      { path: 'trafego-pago/aprovacoes', element: <ApprovalsPage /> },
      { path: 'trafego-pago/aprovacoes/:id', element: <ApprovalDetailPage /> },
    ],
  },
  { path: '*', element: <NotFoundPage /> },
]);
