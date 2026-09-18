import { zodResolver } from '@hookform/resolvers/zod';
import {
  EMPLOYEE_STATUS,
  ROLES,
  assignableRoles,
  employeeCreateSchema,
  formatCpf,
  isValidCpf,
  type EmployeeCreateInput,
  type EmployeeStatus,
  type EmployeeView,
  type RoleKey,
} from '@wings/shared';
import { useEffect, useState } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { z } from 'zod';
import { hasPermission, useSession } from '../api/auth.js';
import { ApiError } from '../api/client.js';
import {
  useCreateEmployee,
  useEmployee,
  useResendInvite,
  useRevealCpf,
  useUpdateEmployee,
} from '../api/employees.js';
import { SectorSelect } from '../components/SectorSelect.js';
import { Alert, Button, Field, Input, Select } from '../components/ui.js';

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: 'Ativo',
  inactive: 'Inativo',
  on_leave: 'Afastado',
};

/** On edit the CPF stays masked, so the field is optional: fill it only to change it. */
const editSchema = employeeCreateSchema.omit({ cpf: true }).extend({
  cpf: z
    .string()
    .optional()
    .refine((value) => !value || isValidCpf(value), 'CPF inválido'),
});

/**
 * One shape for both modes. CPF is optional because an edit keeps the stored
 * value unless the field is filled in; the resolver swaps per mode.
 */
type FormValues = Omit<z.input<typeof employeeCreateSchema>, 'cpf'> & { cpf?: string };

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function EmployeeFormPage() {
  const { id } = useParams<{ id: string }>();
  const isEdit = Boolean(id);
  const navigate = useNavigate();
  const { data: user } = useSession();

  const existing = useEmployee(isEdit ? id : undefined);
  const create = useCreateEmployee();
  const update = useUpdateEmployee(id ?? '');
  const reveal = useRevealCpf(id ?? '');
  const resend = useResendInvite(id ?? '');
  const [inviteNotice, setInviteNotice] = useState<{
    kind: 'success' | 'error';
    text: string;
  } | null>(null);

  const employee: EmployeeView | undefined = existing.data?.employee;

  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    // Both schemas validate the same fields; only CPF's optionality differs.
    resolver: zodResolver(isEdit ? editSchema : employeeCreateSchema) as Resolver<FormValues>,
    defaultValues: { status: 'active', isSectorManager: false },
  });

  useEffect(() => {
    if (!employee) return;
    reset({
      fullName: employee.fullName,
      cpf: '',
      birthDate: employee.birthDate,
      phone: employee.phone,
      email: employee.email,
      cargo: employee.cargo,
      sector: employee.sector,
      role: employee.role,
      admissionDate: employee.admissionDate,
      status: employee.status,
      isSectorManager: employee.isSectorManager,
    });
  }, [employee, reset]);

  // The API enforces these rules again; the form only avoids offering the
  // impossible.
  const actor = user
    ? {
        employeeId: user.employeeId,
        role: user.role,
        sector: user.sector,
        isSectorManager: user.isSectorManager,
      }
    : null;
  const roleOptions: RoleKey[] = actor ? assignableRoles(actor, isEdit ? id : undefined) : [];
  const canSetManagerFlag = user?.role === 'admin_master';
  const canRevealCpf = hasPermission(user, 'employees.pii.view');

  const onSubmit = handleSubmit(async (values) => {
    setInviteNotice(null);
    if (isEdit) {
      const payload: Record<string, unknown> = { ...values };
      if (!values.cpf) delete payload.cpf;
      if (!canSetManagerFlag) delete payload.isSectorManager;
      await update.mutateAsync(payload);
      navigate('/funcionarios');
      return;
    }

    const result = await create.mutateAsync(values as EmployeeCreateInput);
    if (result.invite.sent) {
      navigate(`/funcionarios/${result.employee.id}`, { replace: true });
      setInviteNotice({
        kind: 'success',
        text: `Cadastro concluído. Convite enviado para ${result.employee.email}.`,
      });
    } else {
      // Never imply the e-mail went out: say plainly that it did not.
      navigate(`/funcionarios/${result.employee.id}`, { replace: true });
      setInviteNotice({
        kind: 'error',
        text: result.invite.error?.message ?? 'O e-mail de convite NÃO foi enviado.',
      });
    }
  });

  const failure =
    (create.error ?? update.error) instanceof ApiError
      ? ((create.error ?? update.error) as ApiError)
      : null;

  if (isEdit && existing.isLoading) return <div className="page-loading">Carregando…</div>;
  if (isEdit && existing.isError) {
    return (
      <>
        <header className="page-header">
          <h1>Funcionário</h1>
        </header>
        <Alert kind="error">Registro não encontrado ou fora do seu escopo de acesso.</Alert>
        <p>
          <Link to="/administracao/usuarios">Voltar à lista</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <header className="page-header page-header-row">
        <div>
          <h1>{isEdit ? 'Editar funcionário' : 'Novo funcionário'}</h1>
          <p>
            {isEdit ? employee?.fullName : 'O funcionário definirá a própria senha pelo convite.'}
          </p>
        </div>
        <Link to="/administracao/usuarios" className="btn btn-ghost btn-inline">
          Voltar
        </Link>
      </header>

      {inviteNotice && (
        <Alert kind={inviteNotice.kind === 'success' ? 'success' : 'error'}>
          {inviteNotice.text}
          {inviteNotice.kind === 'error' && id && (
            <>
              {' '}
              <button
                type="button"
                className="link-button"
                disabled={resend.isPending}
                onClick={async () => {
                  try {
                    await resend.mutateAsync();
                    setInviteNotice({ kind: 'success', text: 'Convite reenviado com sucesso.' });
                  } catch (error) {
                    setInviteNotice({
                      kind: 'error',
                      text:
                        error instanceof ApiError
                          ? error.message
                          : 'Não foi possível reenviar o convite.',
                    });
                  }
                }}
              >
                {resend.isPending ? 'Reenviando…' : 'Reenviar convite'}
              </button>
            </>
          )}
        </Alert>
      )}

      {failure && <Alert kind="error">{failure.message}</Alert>}

      <form onSubmit={onSubmit} noValidate>
        <fieldset className="block">
          <legend>Dados pessoais</legend>
          <div className="grid-2">
            <Field label="Nome completo" error={errors.fullName?.message}>
              <Input autoFocus {...register('fullName')} />
            </Field>

            <Field
              label="CPF"
              error={errors.cpf?.message}
              hint={isEdit ? 'Preencha apenas para alterar o CPF.' : undefined}
            >
              <div className="input-row">
                <Input
                  placeholder={isEdit ? employee?.cpfMasked : '000.000.000-00'}
                  {...register('cpf')}
                />
                {isEdit && canRevealCpf && (
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={reveal.isPending}
                    onClick={() => reveal.mutate()}
                  >
                    {reveal.isPending ? '…' : 'Revelar'}
                  </Button>
                )}
              </div>
              {reveal.data && (
                <span className="field-hint reveal">
                  CPF completo: <strong className="mono">{formatCpf(reveal.data.cpf)}</strong> —
                  esta exibição foi registrada no log de auditoria.
                </span>
              )}
              {reveal.isError && (
                <span className="field-error">Não foi possível revelar o CPF.</span>
              )}
            </Field>

            <Field label="Data de nascimento" error={errors.birthDate?.message}>
              <Input type="date" {...register('birthDate')} />
            </Field>

            <Field label="Telefone / WhatsApp" error={errors.phone?.message}>
              <Input placeholder="(11) 99999-9999" {...register('phone')} />
            </Field>

            <Field
              label="E-mail (login)"
              error={errors.email?.message}
              hint="O convite para definir a senha é enviado para este endereço."
            >
              <Input type="email" {...register('email')} />
            </Field>
          </div>
        </fieldset>

        <fieldset className="block">
          <legend>Dados profissionais</legend>
          <div className="grid-2">
            <Field label="Cargo" error={errors.cargo?.message}>
              <Input placeholder="Ex.: Analista de Marketing" {...register('cargo')} />
            </Field>

            <Field label="Setor" error={errors.sector?.message}>
              <SectorSelect {...register('sector')}>
                <option value="">Selecione…</option>
              </SectorSelect>
            </Field>

            <Field
              label="Nível de acesso"
              error={errors.role?.message}
              hint={
                roleOptions.length === 0
                  ? 'Você não pode atribuir níveis de acesso.'
                  : 'Somente níveis abaixo do seu aparecem aqui.'
              }
            >
              <Select {...register('role')}>
                <option value="">Selecione…</option>
                {roleOptions.map((role) => (
                  <option key={role} value={role}>
                    {ROLES[role].name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Data de admissão" error={errors.admissionDate?.message}>
              <Input type="date" {...register('admissionDate')} />
            </Field>

            <Field label="Status" error={errors.status?.message}>
              <Select {...register('status')}>
                {EMPLOYEE_STATUS.map((value) => (
                  <option key={value} value={value}>
                    {STATUS_LABEL[value]}
                  </option>
                ))}
              </Select>
            </Field>

            {canSetManagerFlag && (
              <label className="field checkbox-field">
                <input type="checkbox" {...register('isSectorManager')} />
                <span>
                  É gestor do setor
                  <small className="field-hint">
                    Pode cadastrar e editar funcionários do próprio setor.
                  </small>
                </span>
              </label>
            )}
          </div>
        </fieldset>

        {isEdit && (
          <fieldset className="block">
            <legend>Sistema</legend>
            <div className="grid-3 readonly">
              <div>
                <span className="field-label">Cadastrado por</span>
                <p>{employee?.createdByName ?? '—'}</p>
              </div>
              <div>
                <span className="field-label">Cadastrado em</span>
                <p>{formatDateTime(employee?.createdAt)}</p>
              </div>
              <div>
                <span className="field-label">Último acesso</span>
                <p>{formatDateTime(employee?.lastLoginAt)}</p>
              </div>
            </div>
            <p className="field-hint">
              A senha é definida pelo próprio funcionário através do convite — ninguém mais tem
              acesso a ela.
            </p>
          </fieldset>
        )}

        <div className="form-actions">
          <Button type="submit" disabled={isSubmitting}>
            {isSubmitting
              ? 'Salvando…'
              : isEdit
                ? 'Salvar alterações'
                : 'Cadastrar e enviar convite'}
          </Button>
          {isEdit && watch('status') === 'inactive' && (
            <span className="field-hint">
              Ao salvar como inativo, as sessões ativas deste funcionário são encerradas.
            </span>
          )}
        </div>
      </form>
    </>
  );
}
