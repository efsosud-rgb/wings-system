import type { CampaignVerdict, HealthState, SignalState } from '@wings/shared';

/**
 * The dashboard's state icons, drawn once in the same 1.8px stroke as the
 * tree toggles. A state is always icon plus text on screen, never colour
 * alone: the icon is what a colour-blind reader tells them apart by.
 */

export type StateKey = 'good' | 'attention' | 'bad' | 'unknown' | 'insufficient';

export function stateOfVerdict(verdict: CampaignVerdict): StateKey {
  if (verdict === 'positive') return 'good';
  if (verdict === 'attention') return 'attention';
  if (verdict === 'negative') return 'bad';
  if (verdict === 'insufficient') return 'insufficient';
  return 'unknown';
}

export function stateOfSignal(state: SignalState): StateKey {
  if (state === 'good') return 'good';
  if (state === 'neutral') return 'attention';
  if (state === 'bad') return 'bad';
  return 'unknown';
}

export function stateOfHealth(state: HealthState): StateKey {
  if (state === 'ok') return 'good';
  if (state === 'attention') return 'attention';
  if (state === 'problem') return 'bad';
  return 'unknown';
}

const PATH: Record<StateKey, string> = {
  // A tick inside a circle.
  good: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z M5.2 8.2l2 2 3.8-4',
  // A triangle with a bar: the warning sign.
  attention: 'M8 2.2l6 10.6H2z M8 6.6v3 M8 11.6v.4',
  // A cross inside a circle.
  bad: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z M5.6 5.6l4.8 4.8 M10.4 5.6l-4.8 4.8',
  // A dash inside a circle: nothing to judge.
  unknown: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z M5 8h6',
  // A dotted circle: not enough to say.
  insufficient: 'M8 1.5a6.5 6.5 0 1 1 0 13 6.5 6.5 0 0 1 0-13z',
};

export function StateIcon({ state }: { state: StateKey }) {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true" className="state-icon">
      <path
        d={PATH[state]}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeDasharray={state === 'insufficient' ? '2.2 2.6' : undefined}
      />
    </svg>
  );
}

/** A small pill: the icon, then the word. */
export function StatePill({ state, children }: { state: StateKey; children: React.ReactNode }) {
  return (
    <span className={`state-pill state-${state}`}>
      <StateIcon state={state} />
      {children}
    </span>
  );
}
