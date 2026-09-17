import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../../../db/client.js';
import { adAccounts, employees, roles } from '../../../db/schema/index.js';
import { normalizeBrazilianPhone, type ZapiClient } from '../../../lib/zapi.js';
import type { AlertNotification, AlertNotifier } from '../alerts.js';

/**
 * WhatsApp for operational alerts.
 *
 * Only *critical* alerts get here — a rejected ad or a campaign spending with
 * nothing to show for it. Pacing and fatigue live in the cockpit feed, because
 * an alert that buzzes for everything soon buzzes for nothing.
 *
 * The message describes and links; it never offers an action. Anything that
 * moves money still happens behind a login, through the approvals gate.
 */

export interface AlertWhatsAppOptions {
  db: Database;
  client: ZapiClient;
  appBaseUrl: string;
  /** Numbers for people who are not employees in the system yet. */
  extraPhones?: string[];
  fallback?: AlertNotifier;
  log?: (message: string) => void;
}

export class WhatsAppAlertNotifier implements AlertNotifier {
  constructor(private readonly options: AlertWhatsAppOptions) {}

  async send(notification: AlertNotification): Promise<void> {
    const recipients = await this.recipients();

    if (recipients.length === 0) {
      this.options.log?.(
        `[alerts] no WhatsApp recipient configured for "${notification.kind}"; falling back to log`,
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
        // Never log more of a number than its last four digits.
        failures.push(
          `…${phone.slice(-4)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    if (failures.length > 0) {
      throw new Error(
        `WhatsApp delivery failed for ${failures.length} recipient(s): ${failures.join('; ')}`,
      );
    }
  }

  /** Same three people who decide approvals: Admin Master plus Diretoria. */
  private async recipients(): Promise<string[]> {
    const rows = await this.options.db
      .select({ phone: employees.phone })
      .from(employees)
      .innerJoin(roles, eq(roles.id, employees.roleId))
      .where(
        and(inArray(roles.key, ['admin_master', 'diretoria']), eq(employees.status, 'active')),
      );

    const numbers = [...rows.map((row) => row.phone), ...(this.options.extraPhones ?? [])]
      .map((phone) => normalizeBrazilianPhone(phone))
      .filter((phone): phone is string => phone !== null);

    return [...new Set(numbers)];
  }

  private async compose(notification: AlertNotification): Promise<string> {
    const account = await this.options.db.query.adAccounts.findFirst({
      where: eq(adAccounts.id, notification.adAccountId),
    });
    const accountLabel = account
      ? `${account.platform.toUpperCase()} — ${account.name}`
      : 'conta de anúncios';
    const link = new URL('/trafego-pago', this.options.appBaseUrl).toString();

    const lines = [
      '🚨 *Wings System — alerta de tráfego pago*',
      '',
      `Conta: ${accountLabel}`,
      notification.title,
    ];

    const reasons = notification.detail.reasons;
    if (Array.isArray(reasons) && reasons.length > 0) {
      lines.push('', `Motivo informado pela plataforma: ${reasons.join('; ')}`);
    }

    lines.push('', 'Nenhuma alteração foi feita automaticamente.', '', `Abrir o cockpit: ${link}`);
    return lines.join('\n');
  }
}
