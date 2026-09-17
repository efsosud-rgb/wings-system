import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { adAccounts, employees, roles } from '../../../db/schema/index.js';
import { normalizeBrazilianPhone, type ZapiClient } from '../../../lib/zapi.js';
import type { ApprovalNotification, ApprovalNotifier } from '../approvals.js';
import { formatBrl } from '../platform/money.js';

/**
 * WhatsApp notifications for the approvals gate.
 *
 * Who hears about what:
 *   - a new request  → Admin Master
 *   - an escalation  → Diretoria (both directors), after 4h unanswered
 *   - a decision     → Admin Master, for the record
 *
 * The message carries a link into Wings System; it never contains a way to
 * approve from WhatsApp itself. A WhatsApp reply cannot be authenticated
 * strongly enough to move money, so the decision always happens behind a login.
 */

const TRIGGER_LABEL: Record<ApprovalNotification['trigger'], string> = {
  policy_always: 'toda alteração de orçamento exige aprovação',
  above_single_threshold: 'alteração acima do limite individual',
  cumulative_24h: 'limite acumulado de 24h atingido',
};

export interface WhatsAppNotifierOptions {
  db: Database;
  client: ZapiClient;
  /** Public base URL used to build the approval link. */
  appBaseUrl: string;
  /**
   * Numbers for people who are not employees in the system yet. Merged with
   * whatever the employee records provide.
   */
  extraAdminPhones?: string[];
  extraDiretoriaPhones?: string[];
  /** Used when nothing is configured for a stage. */
  fallback?: ApprovalNotifier;
  log?: (message: string) => void;
}

export class WhatsAppApprovalNotifier implements ApprovalNotifier {
  constructor(private readonly options: WhatsAppNotifierOptions) {}

  async send(notification: ApprovalNotification): Promise<void> {
    const recipients = await this.recipientsFor(notification);

    if (recipients.length === 0) {
      // Nothing configured for this stage: fall back rather than fail, but say
      // so plainly — a missing number must not look like a delivered message.
      this.options.log?.(
        `[approvals] no WhatsApp recipient configured for "${notification.kind}"; falling back to log`,
      );
      await this.options.fallback?.send(notification);
      return;
    }

    const message = await this.compose(notification);
    const failures: string[] = [];

    for (const phone of recipients) {
      try {
        await this.options.client.sendText(phone, message);
      } catch (error) {
        // Never log the number itself beyond its last four digits.
        failures.push(
          `…${phone.slice(-4)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failures.length > 0) {
      // Thrown so the gate records the failure and keeps the request pending.
      throw new Error(
        `WhatsApp delivery failed for ${failures.length} recipient(s): ${failures.join('; ')}`,
      );
    }
  }

  /** Employees carrying a role, plus any configured extra numbers. */
  private async phonesForRoles(roleKeys: string[], extra: string[] = []): Promise<string[]> {
    const rows = await this.options.db
      .select({ phone: employees.phone })
      .from(employees)
      .innerJoin(roles, eq(roles.id, employees.roleId))
      .where(and(inArray(roles.key, roleKeys), eq(employees.status, 'active')));

    const numbers = [...rows.map((row) => row.phone), ...extra]
      .map((phone) => normalizeBrazilianPhone(phone))
      .filter((phone): phone is string => phone !== null);

    return [...new Set(numbers)];
  }

  private recipientsFor(notification: ApprovalNotification): Promise<string[]> {
    switch (notification.kind) {
      case 'escalated':
        // After 4h it becomes Diretoria's call: both directors are told.
        return this.phonesForRoles(['diretoria'], this.options.extraDiretoriaPhones ?? []);
      case 'requested':
      case 'decided':
        return this.phonesForRoles(['admin_master'], this.options.extraAdminPhones ?? []);
    }
  }

  private async compose(notification: ApprovalNotification): Promise<string> {
    const account = await this.options.db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, notification.adAccountId),
    });
    const accountLabel = account
      ? `${account.platform.toUpperCase()} — ${account.name}`
      : 'conta de anúncios';
    const amount = formatBrl(notification.amountCents);
    const link = new URL(
      `/trafego-pago/aprovacoes/${notification.approvalId}`,
      this.options.appBaseUrl,
    ).toString();

    if (notification.kind === 'escalated') {
      return [
        '⏰ *Wings System — aprovação pendente há 4 horas*',
        '',
        `Conta: ${accountLabel}`,
        `Valor: ${amount}`,
        `Motivo: ${TRIGGER_LABEL[notification.trigger]}`,
        '',
        'A solicitação segue *aguardando decisão* e foi encaminhada à Diretoria.',
        'Nada foi executado.',
        '',
        `Decidir: ${link}`,
      ].join('\n');
    }

    if (notification.kind === 'decided') {
      const verdict = notification.status === 'approved' ? '✅ aprovada' : '❌ recusada';
      return [
        `*Wings System — solicitação ${verdict}*`,
        '',
        `Conta: ${accountLabel}`,
        `Valor: ${amount}`,
        '',
        `Detalhes: ${link}`,
      ].join('\n');
    }

    return [
      '🔶 *Wings System — aprovação de orçamento*',
      '',
      `Conta: ${accountLabel}`,
      `Valor: ${amount}`,
      `Motivo: ${TRIGGER_LABEL[notification.trigger]}`,
      '',
      'Nada será executado sem sua decisão.',
      '',
      `Aprovar ou recusar: ${link}`,
      '',
      '_A decisão é feita dentro do sistema, com login — responder esta mensagem não aprova._',
    ].join('\n');
  }
}
