import { zodResolver } from '@hookform/resolvers/zod';
import { forgotPasswordSchema, type ForgotPasswordInput } from '@wings/shared';
import { useForm } from 'react-hook-form';
import { Link } from 'react-router-dom';
import { useForgotPassword } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { Alert, AuthCard, Button, Field, Input } from '../components/ui.js';

export function ForgotPasswordPage() {
  const forgot = useForgotPassword();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<ForgotPasswordInput>({ resolver: zodResolver(forgotPasswordSchema) });

  const onSubmit = handleSubmit(async (values) => {
    await forgot.mutateAsync(values);
  });

  const failure = forgot.error instanceof ApiError ? forgot.error : null;

  return (
    <AuthCard
      title="Esqueci minha senha"
      subtitle="Enviaremos um link para definir uma nova senha."
    >
      {forgot.isSuccess ? (
        // Deliberately the same message whether or not the address exists.
        <Alert kind="success">{forgot.data.message}</Alert>
      ) : (
        <form onSubmit={onSubmit} noValidate>
          <Field label="E-mail" error={errors.email?.message}>
            <Input type="email" autoComplete="username" autoFocus {...register('email')} />
          </Field>

          {failure && <Alert kind="error">{failure.message}</Alert>}

          <Button type="submit" disabled={forgot.isPending}>
            {forgot.isPending ? 'Enviando…' : 'Enviar link'}
          </Button>
        </form>
      )}

      <p className="auth-footer">
        <Link to="/login">Voltar ao login</Link>
      </p>
    </AuthCard>
  );
}
