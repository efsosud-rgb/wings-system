import { z } from 'zod';
import { isValidCpf, normalizeCpf } from '../cpf.js';
import { ROLE_KEYS, type RoleKey } from '../rbac/roles.js';
import { SECTOR_SLUGS, type SectorSlug } from '../rbac/sectors.js';

export const EMPLOYEE_STATUS = ['active', 'inactive', 'on_leave'] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[number];

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Data deve estar no formato AAAA-MM-DD')
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Data inválida');

/** Brazilian mobile/landline, digits only after normalization (10 or 11 digits). */
const phone = z
  .string()
  .transform((value) => value.replace(/\D/g, ''))
  .refine((value) => value.length === 10 || value.length === 11, 'Telefone inválido');

/**
 * Field definitions without defaults.
 *
 * Defaults belong to creation only: if the update schema inherited them, a
 * PATCH of one field would silently reset `status` (reactivating a deactivated
 * employee) and clear `isSectorManager`.
 */
const employeeFields = z.object({
  // Bloco 1 — Dados pessoais
  fullName: z.string().trim().min(3, 'Nome completo obrigatório').max(160),
  cpf: z.string().transform(normalizeCpf).refine(isValidCpf, 'CPF inválido'),
  birthDate: isoDate,
  phone,
  email: z.string().trim().toLowerCase().email('E-mail inválido').max(160),

  // Bloco 2 — Dados profissionais
  cargo: z.string().trim().min(2, 'Cargo obrigatório').max(120),
  sector: z.enum(SECTOR_SLUGS as [SectorSlug, ...SectorSlug[]]),
  role: z.enum(ROLE_KEYS as [RoleKey, ...RoleKey[]]),
  admissionDate: isoDate,
  status: z.enum(EMPLOYEE_STATUS),
  isSectorManager: z.boolean(),
});

export const employeeCreateSchema = employeeFields.extend({
  status: z.enum(EMPLOYEE_STATUS).default('active'),
  isSectorManager: z.boolean().default(false),
});

export type EmployeeCreateInput = z.input<typeof employeeCreateSchema>;
export type EmployeeCreate = z.output<typeof employeeCreateSchema>;

/** Updates carry the same fields, all optional and with no defaults applied. */
export const employeeUpdateSchema = employeeFields.partial();
export type EmployeeUpdate = z.output<typeof employeeUpdateSchema>;

/**
 * What the API returns. CPF is masked unless the caller holds
 * `employees.pii.view`, in which case `cpf` carries the full value.
 */
export interface EmployeeView {
  id: string;
  fullName: string;
  cpfMasked: string;
  cpf?: string;
  birthDate: string;
  phone: string;
  email: string;
  cargo: string;
  sector: SectorSlug;
  role: RoleKey;
  admissionDate: string;
  status: EmployeeStatus;
  isSectorManager: boolean;
  createdBy: string | null;
  /** Name of whoever created the record, for the read-only System block. */
  createdByName: string | null;
  createdAt: string;
  lastLoginAt: string | null;
}

/**
 * Outcome of the automatic invite that follows a registration.
 *
 * Creating an employee always attempts the invite. If it cannot be sent, the
 * employee is still created and this says exactly why, so the operator can be
 * told plainly instead of assuming the e-mail went out.
 */
export type InviteFailureCode = 'email_not_configured' | 'send_failed' | 'employee_inactive';

export interface InviteOutcome {
  sent: boolean;
  error?: {
    code: InviteFailureCode;
    /** Ready to show to the operator, in Portuguese. */
    message: string;
  };
}

export const INVITE_FAILURE_MESSAGE: Record<InviteFailureCode, string> = {
  email_not_configured:
    'Funcionário cadastrado, mas o e-mail de convite NÃO foi enviado: o envio de e-mails ainda não está configurado. Gere o link manualmente ou reenvie o convite depois.',
  send_failed:
    'Funcionário cadastrado, mas o e-mail de convite NÃO foi enviado: falha no servidor de e-mail. Tente reenviar o convite.',
  employee_inactive:
    'Funcionário cadastrado como inativo, portanto o convite NÃO foi enviado. Ative o cadastro e reenvie o convite.',
};

/** Filters accepted by GET /employees. */
export interface EmployeeListQuery {
  search?: string;
  sector?: SectorSlug;
  status?: EmployeeStatus;
  page?: number;
  pageSize?: number;
}

export interface EmployeeListResult {
  employees: EmployeeView[];
  total: number;
  page: number;
  pageSize: number;
}
