import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@wings/shared';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useLogin, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import {
  SESSION_EXPIRED_MESSAGE,
  safeReturnPath,
  type LoginRedirectState,
} from '../api/session-expiry.js';
import { LoginShell } from '../brand/LoginShell.js';
import { Alert, Button, Field, Input } from '../components/ui.js';

export function LoginPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const session = useSession();
  const login = useLogin();
  // Sent by the route gate: where the person was, and whether their session ended.
  const redirect = (location.state ?? null) as LoginRedirectState | null;
  const returnTo = safeReturnPath(redirect?.from) ?? '/';
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  if (session.data) return <Navigate to={returnTo} replace />;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await login.mutateAsync(values);
    } catch {
      return; // the refusal is shown below from `login.error`
    }
    navigate(returnTo, { replace: true });
  });

  const failure = login.error instanceof ApiError ? login.error : null;

  return (
    <LoginShell title="Entrar" subtitle="Acesse com seu e-mail corporativo">
      <form onSubmit={onSubmit} noValidate>
        {redirect?.expired && <Alert kind="warning">{SESSION_EXPIRED_MESSAGE}</Alert>}
        <Field label="E-mail" error={errors.email?.message}>
          <Input type="email" autoComplete="username" autoFocus {...register('email')} />
        </Field>
        <Field label="Senha" error={errors.password?.message}>
          <Input type="password" autoComplete="current-password" {...register('password')} />
        </Field>

        {failure && (
          <Alert kind="error">
            {failure.message}
            {failure.code === 'account_locked' && failure.retryAfterSeconds
              ? ` (aguarde ${Math.ceil(failure.retryAfterSeconds / 60)} min)`
              : ''}
          </Alert>
        )}

        <Button type="submit" disabled={login.isPending}>
          {login.isPending ? 'Entrando…' : 'Entrar'}
        </Button>
      </form>

      <p className="auth-footer">
        <Link to="/esqueci-senha">Esqueci minha senha</Link>
      </p>
    </LoginShell>
  );
}
