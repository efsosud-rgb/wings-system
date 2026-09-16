import { zodResolver } from '@hookform/resolvers/zod';
import { PASSWORD_MIN_LENGTH, passwordSchema } from '@wings/shared';
import { useForm } from 'react-hook-form';
import { Link, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useSetPassword } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import { Alert, AuthCard, Button, Field, Input } from '../components/ui.js';

const formSchema = z
  .object({
    password: passwordSchema,
    confirmation: z.string(),
  })
  .refine((values) => values.password === values.confirmation, {
    message: 'As senhas não conferem',
    path: ['confirmation'],
  });

type FormValues = z.infer<typeof formSchema>;

/**
 * Serves both one-time links: the invite (first password) and the reset. The
 * only difference is the wording; the API decides what the token means.
 */
export function SetPasswordPage({ mode }: { mode: 'invite' | 'reset' }) {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const setPassword = useSetPassword();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(formSchema) });

  const title = mode === 'invite' ? 'Defina sua senha' : 'Redefinir senha';

  if (!token) {
    return (
      <AuthCard title={title}>
        <Alert kind="error">Link inválido: o endereço não contém um token.</Alert>
        <p className="auth-footer">
          <Link to="/esqueci-senha">Solicitar um novo link</Link>
        </p>
      </AuthCard>
    );
  }

  if (setPassword.isSuccess) {
    return (
      <AuthCard title="Senha definida">
        <Alert kind="success">Sua senha foi gravada. Você já pode entrar no sistema.</Alert>
        <p className="auth-footer">
          <Link to="/login">Ir para o login</Link>
        </p>
      </AuthCard>
    );
  }

  const onSubmit = handleSubmit(async (values) => {
    await setPassword.mutateAsync({ token, password: values.password });
  });

  const failure = setPassword.error instanceof ApiError ? setPassword.error : null;

  return (
    <AuthCard
      title={title}
      subtitle={
        mode === 'invite'
          ? 'Escolha a senha que você usará para acessar o Wings System.'
          : 'Escolha uma nova senha para sua conta.'
      }
    >
      <form onSubmit={onSubmit} noValidate>
        <Field
          label="Nova senha"
          error={errors.password?.message}
          hint={`Mínimo de ${PASSWORD_MIN_LENGTH} caracteres. Evite seu nome de usuário e sequências óbvias.`}
        >
          <Input type="password" autoComplete="new-password" autoFocus {...register('password')} />
        </Field>
        <Field label="Confirme a senha" error={errors.confirmation?.message}>
          <Input type="password" autoComplete="new-password" {...register('confirmation')} />
        </Field>

        {failure && (
          <Alert kind="error">
            {failure.message}
            {failure.status === 410 && (
              <>
                {' '}
                <Link to="/esqueci-senha">Solicitar novo link</Link>
              </>
            )}
          </Alert>
        )}

        <Button type="submit" disabled={setPassword.isPending}>
          {setPassword.isPending ? 'Salvando…' : 'Salvar senha'}
        </Button>
      </form>
    </AuthCard>
  );
}
