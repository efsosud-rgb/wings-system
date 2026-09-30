import type {
  CampaignDraftInput,
  PacingSummary,
  PlatformAccountReading,
  SpendCapProjection,
  SpendCapReset,
} from '@wings/shared';
import type { ReactNode } from 'react';
import { hasPermission, useSession } from '../../api/auth.js';
import { useSetSpendCapReset } from '../../api/ads.js';
import { Alert } from '../ui.js';
import { formatBrl, formatDateTime, formatDayMonth } from './format.js';
import { ReconcileNowButton } from './ReconcileNowButton.js';

type WingsTotal = {
  capCents: number;
  usableCents: number;
  committedCents: number;
  spentCents: number;
};

/** Once regardless of platform: the cross-account figure, not any one account's. */
function WingsTotalLine({ wingsTotal }: { wingsTotal: WingsTotal | null }) {
  if (!wingsTotal) return null;
  const availableCents = Math.max(0, wingsTotal.usableCents - wingsTotal.committedCents);
  return (
    <p className="field-hint builder-ceiling-wings-total">
      Total Wings (todas as contas): <strong className="mono">{formatBrl(availableCents)}</strong>{' '}
      ainda planejável de {formatBrl(wingsTotal.usableCents)} utilizáveis.
    </p>
  );
}

/** When this line's figure was read — or, without one, when it was last tried. */
function ReadAt({ reading }: { reading: PlatformAccountReading }) {
  if (reading.status === 'ok') {
    return <p className="field-hint">lido em {formatDateTime(reading.readAtIso)}</p>;
  }
  return (
    <p className="field-hint">
      {reading.attemptedAtIso
        ? `última tentativa em ${formatDateTime(reading.attemptedAtIso)}`
        : 'nunca lido'}
      {reading.readAtIso && ` · última leitura boa em ${formatDateTime(reading.readAtIso)}`}
    </p>
  );
}

/** A platform figure, or "—" and why — never an old number shown as current. */
function PlatformLine({
  label,
  reading,
  value,
  missing,
  children,
}: {
  label: string;
  reading: PlatformAccountReading;
  value: string | null;
  /** Why the platform gives no figure here even on a good read. */
  missing: string;
  children?: ReactNode;
}) {
  return (
    <div className="builder-ceiling-line">
      <span className="field-label">{label}</span>
      <p className="mono">{reading.status === 'ok' && value !== null ? value : '—'}</p>
      {reading.status !== 'ok' ? (
        <p className="field-hint">{reading.reason}</p>
      ) : (
        value === null && <p className="field-hint">{missing}</p>
      )}
      {children}
      <ReadAt reading={reading} />
    </div>
  );
}

function SpendCapResetControl({
  accountId,
  reading,
}: {
  accountId: string | undefined;
  reading: PlatformAccountReading;
}) {
  const { data: user } = useSession();
  const setReset = useSetSpendCapReset(accountId);
  const cap = reading.spendCapCents;

  const rule =
    reading.spendCapReset === 'monthly' && reading.spendCapResetsOn
      ? `limite volta a ${cap !== null ? formatBrl(cap) : 'o valor cheio'} em ${formatDayMonth(reading.spendCapResetsOn)}`
      : 'redefinição do limite: não informada (a API da Meta não diz)';

  return (
    <>
      <p className="field-hint">{rule}</p>
      {hasPermission(user, 'ads.budget_caps.manage') && (
        <label className="field-hint builder-ceiling-reset">
          Redefinição do limite{' '}
          <select
            className="control"
            value={reading.spendCapReset ?? ''}
            disabled={!accountId || setReset.isPending}
            onChange={(event) =>
              setReset.mutate((event.target.value || null) as SpendCapReset | null)
            }
          >
            <option value="">não informada</option>
            <option value="monthly">todo dia 1º</option>
          </select>
        </label>
      )}
    </>
  );
}

function MetaLines({
  accountId,
  reading,
}: {
  accountId: string | undefined;
  reading: PlatformAccountReading;
}) {
  const remaining = reading.spendCapRemainingCents;
  return (
    <>
      <PlatformLine
        label="Limite de gastos da conta na Meta"
        reading={reading}
        value={
          remaining !== null && reading.spendCapCents !== null
            ? `resta ${formatBrl(remaining)} de ${formatBrl(reading.spendCapCents)}`
            : null
        }
        missing="a conta não tem limite de gastos definido na Meta"
      >
        {reading.status === 'ok' && reading.amountSpentCents !== null && (
          <p className="field-hint">
            gasto contado no limite: {formatBrl(reading.amountSpentCents)}
          </p>
        )}
        <SpendCapResetControl accountId={accountId} reading={reading} />
      </PlatformLine>
      <PlatformLine
        label="Próxima cobrança da Meta"
        reading={reading}
        value={reading.amountDueCents !== null ? formatBrl(reading.amountDueCents) : null}
        missing="a Meta não informou o valor da próxima cobrança"
      >
        {reading.status === 'ok' && reading.amountDueCents !== null && (
          <p className="field-hint">gasto ainda não cobrado; não é dinheiro disponível</p>
        )}
      </PlatformLine>
      <PlatformLine
        label="Saldo pré-pago na Meta"
        reading={reading}
        value={reading.prepaidBalanceCents !== null ? formatBrl(reading.prepaidBalanceCents) : null}
        missing={
          reading.fundingKind === 'credit_card'
            ? 'a API da Meta não informa saldo para esta conta (pagamento por cartão); confira na tela de cobrança da Meta'
            : 'a API da Meta não informa saldo para esta conta; confira na tela de cobrança da Meta'
        }
      />
    </>
  );
}

export function AccountCeiling({
  accountId,
  pacing,
  wingsTotal,
  platform,
  pause,
  pauseIncludesThis,
}: {
  accountId: string | undefined;
  pacing: PacingSummary | null | undefined;
  wingsTotal: WingsTotal | null;
  platform: CampaignDraftInput['platform'];
  /** When the Meta account's spending limit runs out under the plan; null when it cannot be judged. */
  pause: SpendCapProjection | null;
  /** Whether the campaign being built is part of that plan. */
  pauseIncludesThis: boolean;
}) {
  if (pacing === undefined) return <p className="muted">Lendo o teto da conta…</p>;

  // Search and YouTube spend from the same Google account: worth saying out
  // loud, since the ceiling below is not this campaign's alone.
  const sharedCaption = platform !== 'meta' && (
    <p className="field-hint">
      Pesquisa e YouTube compartilham a mesma conta e o mesmo teto do Google.
    </p>
  );

  if (pacing === null) {
    return (
      <div className="builder-ceiling">
        <Alert kind="error">
          Não há período de orçamento aberto para esta conta neste mês. Sem teto, nenhum pedido é
          aceito.
        </Alert>
        <p className="field-hint">sem teto próprio</p>
        {sharedCaption}
        <WingsTotalLine wingsTotal={wingsTotal} />
      </div>
    );
  }

  const reading = pacing.platformReading;
  // The ceiling includes what the platform allows: without a current read of
  // it, the figure would be half old, so it is not shown at all.
  const ceilingKnown = reading.status === 'ok';
  return (
    <div className="builder-ceiling">
      <span className="field-label">Teto real da conta neste mês</span>
      <p className="mono builder-ceiling-figure">
        {ceilingKnown ? formatBrl(pacing.availableCents) : '—'}
      </p>
      <p className="field-hint">
        {ceilingKnown
          ? `ainda pode ser planejado, já descontado o limite de gastos da plataforma · reconciliado em ${formatDateTime(pacing.lastReconciledAt)}`
          : `sem teto atual: ${reading.reason ?? 'sem leitura da plataforma'}`}
      </p>
      {sharedCaption}
      <ReconcileNowButton accountId={accountId} />
      <dl>
        <dt>Teto do mês</dt>
        <dd className="mono">{formatBrl(pacing.capCents)}</dd>
        <dt>Utilizável (70%)</dt>
        <dd className="mono">{formatBrl(pacing.usableCents)}</dd>
        <dt>Já comprometido</dt>
        <dd className="mono">{formatBrl(pacing.committedCents)}</dd>
        <dt>Já gasto</dt>
        <dd className="mono">{formatBrl(pacing.spentCents)}</dd>
      </dl>
      {pause?.pauseDate && (
        <Alert kind="error">
          A Meta vai pausar a conta por volta de {formatDayMonth(pause.pauseDate)}, aumente o limite
          de gastos. As campanhas ativas{pauseIncludesThis ? ' e esta' : ''} somam{' '}
          {formatBrl(pause.projectedCents)} até lá, e o limite só permite{' '}
          {formatBrl(pause.allowedCents)}.
        </Alert>
      )}
      <div className="builder-ceiling-platform">
        {platform === 'meta' ? (
          <MetaLines accountId={accountId} reading={reading} />
        ) : (
          <PlatformLine
            label="Saldo/limite informado pela plataforma"
            reading={reading}
            value={
              pacing.platformRemainingCents !== null
                ? formatBrl(pacing.platformRemainingCents)
                : null
            }
            missing={pacing.platformLimitNote ?? 'a plataforma não informa este número'}
          />
        )}
      </div>
      <WingsTotalLine wingsTotal={wingsTotal} />
      {pacing.killSwitchEngaged && (
        <Alert kind="error">Trava de emergência acionada: a conta não aceita pedidos agora.</Alert>
      )}
    </div>
  );
}
