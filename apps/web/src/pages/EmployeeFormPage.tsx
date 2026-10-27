import { zodResolver } from '@hookform/resolvers/zod';
import {
  EMPLOYEE_STATUS,
  ROLES,
  employeeCreateSchema,
  formatCpf,
  isValidCpf,
  loginEmailChangeDenial,
  roleFieldState,
  statusChangeDenial,
  type DenyReason,
  type EmailChangeOutcome,
  type EmployeeCreateInput,
  type EmployeeStatus,
  type EmployeeView,
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
import { PageHeader } from '../components/PageHeader.js';

const STATUS_LABEL: Record<EmployeeStatus, string> = {
  active: 'Ativo',
  inactive: 'Inativo',
  on_leave: 'Afastado',
};

/** Why the access-level select is locked, in the operator's words. */
function roleLockHint(reason: DenyReason): string {
  if (reason === 'self_role_change') return 'Você não pode alterar o próprio nível de acesso.';
  if (reason === 'last_admin_master') {
    return 'Único Admin Master do sistema — não pode ser rebaixado.';
  }
  if (reason === 'diretoria_level') {
    return 'Diretoria é atribuída pela própria Diretoria ou pelo Admin Master.';
  }
  return 'Seu perfil não pode alterar este nível.';
}

/** Why the login e-mail is locked, in the operator's words. */
function emailLockHint(reason: DenyReason): string {
  if (reason === 'self_role_change') {
    return 'Você não pode trocar o próprio e-mail de login. Peça ao RH/DP ou a um Admin Master.';
  }
  if (reason === 'diretoria_level') {
    return 'Só um Admin Master troca o e-mail de login de alguém da Diretoria.';
  }
  if (reason === 'role_rank_too_high') {
    return 'Você não pode trocar o e-mail de login de alguém com nível igual ou maior que o seu.';
  }
  return 'Só quem pode mudar o nível de acesso desta pessoa troca o e-mail de login dela.';
}

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
  const [emailChange, setEmailChange] = useState<EmailChangeOutcome | null>(null);

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
  const chosenSector = watch('sector');
  const roleField = !actor
    ? { options: [], locked: null }
    : isEdit
      ? employee
        ? roleFieldState(actor, {
            employeeId: employee.id,
            sector: employee.sector,
            currentRole: employee.role,
            isLastActiveAdminMaster: employee.isLastActiveAdminMaster,
          })
        : { options: [], locked: null }
      : roleFieldState(actor, { sector: chosenSector || undefined });
  const roleOptions = roleField.options;
  const canSetManagerFlag = user?.role === 'admin_master';
  const canRevealCpf = hasPermission(user, 'employees.pii.view');

  // Everything but the access level is read-only for someone who holds only
  // `employees.assign_roles` (Diretoria), and for anyone but an Admin Master
  // looking at an Admin Master.
  const adminMasterRecord =
    isEdit && employee?.role === 'admin_master' && user?.role !== 'admin_master';
  const fieldsLocked = isEdit && (adminMasterRecord || !hasPermission(user, 'employees.update'));
  const nothingToSave = fieldsLocked && roleField.locked !== null;
  const lock = { disabled: fieldsLocked };

  // The login e-mail is where a password reset goes, so only someone who could
  // also change this person's level may change it. Same rule as the API.
  const emailLock =
    isEdit && employee && actor && !fieldsLocked
      ? loginEmailChangeDenial(actor, {
          employeeId: employee.id,
          sector: employee.sector,
          currentRole: employee.role,
          isLastActiveAdminMaster: employee.isLastActiveAdminMaster,
        })
      : null;
  // Switching someone off or back on needs its own permission; the statuses
  // offered are the ones this actor may move the record to.
  const statusOptions =
    isEdit && employee && actor
      ? EMPLOYEE_STATUS.filter(
          (value) =>
            statusChangeDenial(actor, { sector: employee.sector }, employee.status, value) === null,
        )
      : [...EMPLOYEE_STATUS];
  const statusHint =
    !isEdit || fieldsLocked || statusOptions.length === EMPLOYEE_STATUS.length
      ? undefined
      : employee?.status === 'inactive'
        ? 'Só quem pode inativar funcionários reativa este cadastro.'
        : 'Inativar exige a permissão de inativar funcionários.';

  async function resendInvite() {
    try {
      await resend.mutateAsync();
      setInviteNotice({ kind: 'success', text: 'Convite reenviado com sucesso.' });
    } catch (error) {
      setInviteNotice({
        kind: 'error',
        text: error instanceof ApiError ? error.message : 'Não foi possível reenviar o convite.',
      });
    }
  }

  const onSubmit = handleSubmit(async (values) => {
    setInviteNotice(null);
    setEmailChange(null);
    if (isEdit) {
      const roleChanged = Boolean(employee) && values.role !== employee?.role;
      if (roleChanged && employee && ROLES[values.role].rank < ROLES[employee.role].rank) {
        const confirmed = window.confirm(
          `Rebaixar o nível de acesso de "${ROLES[employee.role].name}" para "${ROLES[values.role].name}"? As sessões ativas deste funcionário serão encerradas.`,
        );
        if (!confirmed) return;
      }

      // With the rest of the record locked, only the level travels.
      const payload: Record<string, unknown> = fieldsLocked ? {} : { ...values };
      if (!values.cpf) delete payload.cpf;
      if (!canSetManagerFlag) delete payload.isSectorManager;
      // An unchanged level is left out: there is nothing to authorize.
      if (roleChanged) payload.role = values.role;
      else delete payload.role;
      if (emailLock) delete payload.email;
      const result = await update.mutateAsync(payload);
      // A new login e-mail ends the person's sessions and warns the old
      // address: stay here and say what happened, including a failed warning.
      if (result.emailChange) {
        setEmailChange(result.emailChange);
        return;
      }
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
        <PageHeader title="Funcionário" />
        <Alert kind="error">Registro não encontrado ou fora do seu escopo de acesso.</Alert>
        <p>
          <Link to="/administracao/usuarios">Voltar à lista</Link>
        </p>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={isEdit ? 'Editar funcionário' : 'Novo funcionário'}
        subtitle={
          isEdit ? employee?.fullName : 'O funcionário definirá a própria senha pelo convite.'
        }
        actions={
          <Link to="/administracao/usuarios" className="btn btn-ghost btn-inline">
            Voltar
          </Link>
        }
      />

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
                onClick={() => void resendInvite()}
              >
                {resend.isPending ? 'Reenviando…' : 'Reenviar convite'}
              </button>
            </>
          )}
        </Alert>
      )}

      {emailChange && (
        <Alert kind={emailChange.notice.sent ? 'success' : 'error'}>
          E-mail de login trocado. Esta pessoa saiu de todas as sessões e entra de novo com o
          endereço novo.{' '}
          {emailChange.notice.sent
            ? 'O aviso da troca foi enviado ao endereço antigo.'
            : (emailChange.notice.error?.message ?? 'O aviso ao endereço antigo NÃO foi enviado.')}
          {emailChange.linksCancelled > 0 && (
            <>
              {' '}
              Os links de definir senha que estavam pendentes foram cancelados. Se ela ainda não
              definiu a senha,{' '}
              <button
                type="button"
                className="link-button"
                disabled={resend.isPending}
                onClick={() => void resendInvite()}
              >
                {resend.isPending ? 'reenviando…' : 'reenvie o convite'}
              </button>
              .
            </>
          )}
        </Alert>
      )}

      {failure && <Alert kind="error">{failure.message}</Alert>}

      {fieldsLocked && (
        <Alert kind="info">
          {adminMasterRecord
            ? 'Apenas um Admin Master pode alterar o cadastro de um Admin Master.'
            : 'Seu perfil altera apenas o nível de acesso deste cadastro.'}
        </Alert>
      )}

      <form onSubmit={onSubmit} noValidate>
        <fieldset className="block">
          <legend>Dados pessoais</legend>
          <div className="grid-2">
            <Field label="Nome completo" error={errors.fullName?.message}>
              <Input autoFocus {...register('fullName')} {...lock} />
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
                  {...lock}
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
              <Input type="date" {...register('birthDate')} {...lock} />
            </Field>

            <Field label="Telefone / WhatsApp" error={errors.phone?.message}>
              <Input placeholder="(11) 99999-9999" {...register('phone')} {...lock} />
            </Field>

            <Field
              label="E-mail (login)"
              error={errors.email?.message}
              hint={
                emailLock
                  ? emailLockHint(emailLock)
                  : isEdit && !fieldsLocked
                    ? 'Trocar o e-mail encerra as sessões desta pessoa e avisa o endereço antigo.'
                    : 'O convite para definir a senha é enviado para este endereço.'
              }
            >
              <Input
                type="email"
                {...register('email')}
                disabled={fieldsLocked || emailLock !== null}
              />
            </Field>
          </div>
        </fieldset>

        <fieldset className="block">
          <legend>Dados profissionais</legend>
          <div className="grid-2">
            <Field label="Cargo" error={errors.cargo?.message}>
              <Input placeholder="Ex.: Analista de Marketing" {...register('cargo')} {...lock} />
            </Field>

            <Field label="Setor" error={errors.sector?.message}>
              <SectorSelect {...register('sector')} {...lock}>
                <option value="">Selecione…</option>
              </SectorSelect>
            </Field>

            <Field
              label="Nível de acesso"
              error={errors.role?.message}
              hint={
                roleField.locked
                  ? roleLockHint(roleField.locked)
                  : roleOptions.length === 0
                    ? 'Você não pode atribuir níveis de acesso.'
                    : 'Aparecem aqui os níveis que o seu perfil pode atribuir.'
              }
            >
              <Select {...register('role')} disabled={roleField.locked !== null}>
                {!isEdit && <option value="">Selecione…</option>}
                {roleOptions.map((role) => (
                  <option key={role} value={role}>
                    {ROLES[role].name}
                  </option>
                ))}
              </Select>
            </Field>

            <Field label="Data de admissão" error={errors.admissionDate?.message}>
              <Input type="date" {...register('admissionDate')} {...lock} />
            </Field>

            <Field label="Status" error={errors.status?.message} hint={statusHint}>
              <Select
                {...register('status')}
                disabled={fieldsLocked || (isEdit && statusOptions.length <= 1)}
              >
                {statusOptions.map((value) => (
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
          <Button type="submit" disabled={isSubmitting || nothingToSave}>
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
