import { formatBrl, type MediaProviderStatus } from '@wings/shared';

/**
 * One line per provider: what it holds or has left today, or why it cannot
 * serve. The same words the selector's group labels use, so the two agree.
 */

/** "94 créditos", "US$ 12,50", "12 de 50 hoje", or nothing to say. */
export function providerHolding(status: MediaProviderStatus): string | null {
  if (status.quota) {
    const minute =
      status.quota.perMinuteLimit !== null
        ? `, ${status.quota.usedThisMinute ?? 0} de ${status.quota.perMinuteLimit} por minuto`
        : '';
    return `${status.quota.usedToday} de ${status.quota.dailyLimit} hoje${minute}`;
  }
  if (status.balance) {
    if (status.balance.credits !== null) {
      return `${status.balance.credits.toLocaleString('pt-BR')} créditos`;
    }
    if (status.balance.usd !== null) {
      const usd = status.balance.usd.toLocaleString('pt-BR', {
        style: 'currency',
        currency: 'USD',
      });
      return status.balance.brlCents !== null
        ? `${usd} (${formatBrl(status.balance.brlCents)})`
        : usd;
    }
    return 'saldo não informado';
  }
  return null;
}

export function ProviderStrip({ providers }: { providers: MediaProviderStatus[] }) {
  return (
    <ul className="provider-strip" aria-label="Provedores de mídia">
      {providers.map((status) => {
        const holding = providerHolding(status);
        return (
          <li
            key={status.id}
            className={`provider-chip ${status.available ? 'provider-chip-on' : 'provider-chip-off'}`}
          >
            <strong>{status.name}</strong>
            <span className="muted">
              {status.available
                ? holding
                  ? ` · ${holding}`
                  : ' · disponível'
                : ` · ${status.reason ?? 'indisponível'}`}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
