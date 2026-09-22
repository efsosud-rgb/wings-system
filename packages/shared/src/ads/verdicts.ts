import { formatBrl } from '../marketing/media-providers.js';
import { deltaPercent } from './dashboard.js';

/**
 * The verdict on a campaign: "Positiva", "Atenção" or "Negativa", from the
 * numbers and nothing else.
 *
 * One rule, here, used by the API (which has the figures) and shown by the
 * screen (which explains it). Every verdict carries its reasons, each one a
 * sentence with the numbers in it, so nobody has to trust a colour. A leads
 * campaign with no confirmed CPL target is "Sem meta": the target is a
 * person's decision (Configurações do Dashboard), never a guess of ours.
 */

export const CAMPAIGN_VERDICTS = [
  'positive',
  'attention',
  'negative',
  'no_target',
  'insufficient',
] as const;
export type CampaignVerdict = (typeof CAMPAIGN_VERDICTS)[number];

export const CAMPAIGN_VERDICT_LABEL: Record<CampaignVerdict, string> = {
  positive: 'Positiva',
  attention: 'Atenção',
  negative: 'Negativa',
  no_target: 'Sem meta',
  insufficient: 'Poucos dados',
};

/** What a campaign is judged by, from the objective the platform reports. */
export const OBJECTIVE_KINDS = ['leads', 'traffic', 'awareness', 'engagement', 'unknown'] as const;
export type ObjectiveKind = (typeof OBJECTIVE_KINDS)[number];

export const OBJECTIVE_KIND_LABEL: Record<ObjectiveKind, string> = {
  leads: 'Leads e conversão',
  traffic: 'Tráfego',
  awareness: 'Reconhecimento e alcance',
  engagement: 'Engajamento e vídeo',
  unknown: 'Objetivo não informado',
};

/**
 * Meta names objectives (OUTCOME_LEADS…); Google does not, and every Google
 * campaign of Wings so far is a Search campaign after franchise leads, so a
 * Google campaign without an objective is judged as a leads campaign.
 */
export function objectiveKindOf(objective: string | null, platform: 'meta' | 'google'): ObjectiveKind {
  if (objective === null || objective === '') return platform === 'google' ? 'leads' : 'unknown';
  if (/LEAD|SALES|CONVERSION/i.test(objective)) return 'leads';
  if (/TRAFFIC|LINK_CLICKS/i.test(objective)) return 'traffic';
  if (/AWARENESS|REACH|BRAND/i.test(objective)) return 'awareness';
  if (/ENGAGEMENT|VIDEO/i.test(objective)) return 'engagement';
  return 'unknown';
}

export const VERDICT_SIGNALS = ['cpl', 'ctr', 'trend', 'frequency', 'pacing'] as const;
export type VerdictSignal = (typeof VERDICT_SIGNALS)[number];

export const VERDICT_SIGNAL_LABEL: Record<VerdictSignal, string> = {
  cpl: 'CPL contra a meta',
  ctr: 'CTR contra a mediana da conta',
  trend: 'Tendência, 7 dias contra os 7 anteriores',
  frequency: 'Frequência',
  pacing: 'Ritmo de gasto contra o orçamento',
};

export type SignalState = 'good' | 'neutral' | 'bad' | 'unknown';

export interface VerdictReason {
  signal: VerdictSignal;
  state: SignalState;
  /** One sentence with the numbers in it. */
  text: string;
}

export interface VerdictResult {
  verdict: CampaignVerdict;
  /** Which signal decides first: CPL for leads campaigns, CTR for the rest. */
  primary: 'cpl' | 'ctr';
  reasons: VerdictReason[];
}

/** The thresholds, exported so the screen's legend says the same thing the rule does. */
export const VERDICT_RULES = {
  /** Below either, the campaign is not judged. */
  minSpendCents: 2000,
  minImpressions: 500,
  /** CPL against the target: good up to −10%, attention up to +15%, negative beyond. */
  cplGoodRatio: 0.9,
  cplAttentionRatio: 1.15,
  /** No lead at all is negative once the spend passes twice the target. */
  cplNoLeadSpendRatio: 2,
  /** CTR against the account's median over 90 days. */
  ctrGoodRatio: 1.1,
  ctrAttentionRatio: 0.8,
  /** Trend of the primary figure, last 7 days against the 7 before. */
  cplTrendGoodPercent: -15,
  cplTrendBadPercent: 25,
  ctrTrendGoodPercent: 15,
  ctrTrendBadPercent: -20,
  /** Frequency over the window (a floor, since reach is summed by day). */
  frequencyAttentionMilli: 2000,
  frequencyBadMilli: 3000,
  /** Spend of the last 7 days against 7 × the daily budget. */
  pacingGoodMin: 0.7,
  pacingGoodMax: 1.25,
  pacingAttentionMin: 0.4,
  pacingAttentionMax: 1.5,
} as const;

export interface VerdictInput {
  objectiveKind: ObjectiveKind;
  /** Over the window being judged. */
  spendCents: number;
  impressions: number;
  conversions: number;
  cplCents: number | null;
  ctrMilli: number | null;
  frequencyMilli: number | null;
  /** The confirmed CPL target for this objective; null when nobody confirmed one. */
  targetCplCents: number | null;
  /** Median CTR (x1000) of the account's campaigns over 90 days; null with too few. */
  accountMedianCtrMilli: number | null;
  /** Last 7 days against the 7 before, of the primary figure. */
  trend: {
    currentCplCents: number | null;
    previousCplCents: number | null;
    currentCtrMilli: number | null;
    previousCtrMilli: number | null;
  };
  /** Spend of the last 7 days and the daily budget in force; null budget when it lives elsewhere. */
  pacing: { last7SpendCents: number; dailyBudgetCents: number | null };
}

const pct = (value: number) => `${value > 0 ? '+' : ''}${value}%`;
const ctr = (milli: number) => `${(milli / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })}%`;

function cplSignal(input: VerdictInput): VerdictReason {
  if (input.objectiveKind !== 'leads') {
    return { signal: 'cpl', state: 'unknown', text: 'Campanha sem objetivo de leads: o CPL não é o número dela.' };
  }
  if (input.targetCplCents === null) {
    return { signal: 'cpl', state: 'unknown', text: 'Sem meta de CPL confirmada em Configurações do Dashboard.' };
  }
  const target = input.targetCplCents;
  if (input.cplCents === null) {
    const bad = input.spendCents >= target * VERDICT_RULES.cplNoLeadSpendRatio;
    return {
      signal: 'cpl',
      state: bad ? 'bad' : 'neutral',
      text: bad
        ? `Nenhum lead com ${formatBrl(input.spendCents)} gastos, mais que ${VERDICT_RULES.cplNoLeadSpendRatio}× a meta de ${formatBrl(target)}.`
        : `Nenhum lead ainda; gasto de ${formatBrl(input.spendCents)} abaixo de ${VERDICT_RULES.cplNoLeadSpendRatio}× a meta de ${formatBrl(target)}.`,
    };
  }
  const ratio = input.cplCents / target;
  const delta = Math.round((ratio - 1) * 100);
  const state: SignalState =
    ratio <= VERDICT_RULES.cplGoodRatio ? 'good' : ratio <= VERDICT_RULES.cplAttentionRatio ? 'neutral' : 'bad';
  return {
    signal: 'cpl',
    state,
    text: `CPL ${formatBrl(input.cplCents)} contra a meta de ${formatBrl(target)} (${pct(delta)}), ${input.conversions} lead(s).`,
  };
}

function ctrSignal(input: VerdictInput): VerdictReason {
  if (input.ctrMilli === null) {
    return { signal: 'ctr', state: 'unknown', text: 'Sem impressões no período.' };
  }
  if (input.accountMedianCtrMilli === null || input.accountMedianCtrMilli === 0) {
    return { signal: 'ctr', state: 'unknown', text: `CTR ${ctr(input.ctrMilli)}; a conta ainda não tem mediana de 90 dias.` };
  }
  const ratio = input.ctrMilli / input.accountMedianCtrMilli;
  const state: SignalState =
    ratio >= VERDICT_RULES.ctrGoodRatio ? 'good' : ratio >= VERDICT_RULES.ctrAttentionRatio ? 'neutral' : 'bad';
  return {
    signal: 'ctr',
    state,
    text: `CTR ${ctr(input.ctrMilli)} contra a mediana da conta de ${ctr(input.accountMedianCtrMilli)} em 90 dias (${pct(Math.round((ratio - 1) * 100))}).`,
  };
}

function trendSignal(input: VerdictInput, primary: 'cpl' | 'ctr'): VerdictReason {
  if (primary === 'cpl') {
    const delta = deltaPercent(input.trend.currentCplCents, input.trend.previousCplCents);
    if (delta === null) {
      return { signal: 'trend', state: 'unknown', text: 'Sem CPL nas duas semanas para comparar.' };
    }
    const state: SignalState =
      delta <= VERDICT_RULES.cplTrendGoodPercent ? 'good' : delta >= VERDICT_RULES.cplTrendBadPercent ? 'bad' : 'neutral';
    return {
      signal: 'trend',
      state,
      text: `CPL de ${formatBrl(input.trend.currentCplCents ?? 0)} nos últimos 7 dias contra ${formatBrl(input.trend.previousCplCents ?? 0)} nos 7 anteriores (${pct(delta)}).`,
    };
  }
  const delta = deltaPercent(input.trend.currentCtrMilli, input.trend.previousCtrMilli);
  if (delta === null) {
    return { signal: 'trend', state: 'unknown', text: 'Sem CTR nas duas semanas para comparar.' };
  }
  const state: SignalState =
    delta >= VERDICT_RULES.ctrTrendGoodPercent ? 'good' : delta <= VERDICT_RULES.ctrTrendBadPercent ? 'bad' : 'neutral';
  return {
    signal: 'trend',
    state,
    text: `CTR ${ctr(input.trend.currentCtrMilli ?? 0)} nos últimos 7 dias contra ${ctr(input.trend.previousCtrMilli ?? 0)} nos 7 anteriores (${pct(delta)}).`,
  };
}

function frequencySignal(input: VerdictInput): VerdictReason {
  if (input.frequencyMilli === null) {
    return { signal: 'frequency', state: 'unknown', text: 'A plataforma não informou alcance.' };
  }
  const value = (input.frequencyMilli / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 2 });
  const state: SignalState =
    input.frequencyMilli >= VERDICT_RULES.frequencyBadMilli
      ? 'bad'
      : input.frequencyMilli >= VERDICT_RULES.frequencyAttentionMilli
        ? 'neutral'
        : 'good';
  return {
    signal: 'frequency',
    state,
    text: `Frequência ${value} no período${state === 'bad' ? ': o mesmo público já viu o anúncio 3 vezes ou mais' : ''}.`,
  };
}

function pacingSignal(input: VerdictInput): VerdictReason {
  const budget = input.pacing.dailyBudgetCents;
  if (budget === null || budget <= 0) {
    return { signal: 'pacing', state: 'unknown', text: 'Orçamento diário fora da campanha (nos conjuntos) ou não informado.' };
  }
  const expected = budget * 7;
  const ratio = input.pacing.last7SpendCents / expected;
  const state: SignalState =
    ratio >= VERDICT_RULES.pacingGoodMin && ratio <= VERDICT_RULES.pacingGoodMax
      ? 'good'
      : ratio >= VERDICT_RULES.pacingAttentionMin && ratio <= VERDICT_RULES.pacingAttentionMax
        ? 'neutral'
        : 'bad';
  return {
    signal: 'pacing',
    state,
    text: `Gastou ${formatBrl(input.pacing.last7SpendCents)} em 7 dias de um orçamento de ${formatBrl(expected)} (${Math.round(ratio * 100)}%).`,
  };
}

export function verdictOf(input: VerdictInput): VerdictResult {
  const primary: 'cpl' | 'ctr' = input.objectiveKind === 'leads' ? 'cpl' : 'ctr';
  const reasons: VerdictReason[] = [
    cplSignal(input),
    ctrSignal(input),
    trendSignal(input, primary),
    frequencySignal(input),
    pacingSignal(input),
  ];

  if (input.spendCents < VERDICT_RULES.minSpendCents || input.impressions < VERDICT_RULES.minImpressions) {
    return { verdict: 'insufficient', primary, reasons };
  }
  if (primary === 'cpl' && input.targetCplCents === null) {
    return { verdict: 'no_target', primary, reasons };
  }

  const primaryReason = reasons.find((reason) => reason.signal === primary);
  const bad = reasons.filter((reason) => reason.state === 'bad').length;
  const neutral = reasons.filter((reason) => reason.state === 'neutral').length;

  if (primaryReason?.state === 'bad' || bad >= 2) return { verdict: 'negative', primary, reasons };
  if (bad >= 1 || primaryReason?.state === 'neutral' || neutral >= 2) {
    return { verdict: 'attention', primary, reasons };
  }
  return { verdict: 'positive', primary, reasons };
}
