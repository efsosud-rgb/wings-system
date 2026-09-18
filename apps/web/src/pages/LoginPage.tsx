import { zodResolver } from '@hookform/resolvers/zod';
import { loginSchema, type LoginInput } from '@wings/shared';
import { useForm } from 'react-hook-form';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import { useLogin, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { Alert, AuthCard, Button, Field, Input } from '../components/ui.js';

export function LoginPage() {
  const navigate = useNavigate();
  const session = useSession();
  const login = useLogin();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginInput>({ resolver: zodResolver(loginSchema) });

  if (session.data) return <Navigate to="/" replace />;

  const onSubmit = handleSubmit(async (values) => {
    await login.mutateAsync(values);
    navigate('/funcionarios', { replace: true });
  });

  const failure = login.error instanceof ApiError ? login.error : null;

  return (
    <AuthCard title="Entrar" subtitle="Acesse com seu e-mail corporativo">
      <form onSubmit={onSubmit} noValidate>
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
    </AuthCard>
  );
}
