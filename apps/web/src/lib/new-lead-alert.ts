import type { NewLeadPopup } from '@wings/shared';

/**
 * The browser's side of the new-lead pop-up: the short sound, the system notification for a tab
 * nobody is looking at, and the list of pop-ups the person put off. Every call is best effort — a
 * blocked sound, a refused notification or blocked storage must never break the screen.
 */

let audio: AudioContext | null = null;

/** Two short soft tones (about a third of a second). Browsers may keep it silent until the person has clicked once. */
export function playNewLeadSound(): void {
  try {
    const Context = window.AudioContext;
    if (!Context) return;
    audio ??= new Context();
    const context = audio;
    void context.resume();
    [880, 1175].forEach((hz, index) => {
      const start = context.currentTime + index * 0.16;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = 'sine';
      oscillator.frequency.value = hz;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.12, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.14);
      oscillator.connect(gain).connect(context.destination);
      oscillator.start(start);
      oscillator.stop(start + 0.16);
    });
  } catch {
    // No sound: the pop-up is there all the same.
  }
}

/** The page is not in front of the person: hidden tab, or another window has the focus. */
export const pageIsAway = (): boolean => document.hidden || !document.hasFocus();

export const notificationPermission = (): NotificationPermission | 'unsupported' =>
  typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;

/** Asks the person (from a click); resolves to the answer, `unsupported` when the browser has none. */
export async function askNotificationPermission(): Promise<NotificationPermission | 'unsupported'> {
  if (typeof Notification === 'undefined') return 'unsupported';
  try {
    return await Notification.requestPermission();
  } catch {
    return Notification.permission;
  }
}

/** The system notification for a lead that arrived while the page was away; first name, funnel and origin only. */
export function showNewLeadNotification(lead: NewLeadPopup, onOpen: () => void): void {
  if (notificationPermission() !== 'granted') return;
  try {
    const note = new Notification(`Novo lead: ${lead.firstName || 'sem nome'}`, {
      body: `${lead.funnel} · ${lead.origin}`,
      tag: `new-lead-${lead.noticeId}`,
    });
    note.onclick = () => {
      window.focus();
      onOpen();
      note.close();
    };
  } catch {
    // Some phones only allow notifications through a service worker: the pop-up is enough there.
  }
}

const DISMISSED_KEY = 'wings:new-lead-popups:dismissed';
const DISMISSED_KEEP = 200;

export function readDismissed(): Set<string> {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((id) => typeof id === 'string') : []);
  } catch {
    return new Set();
  }
}

export function saveDismissed(ids: Set<string>): void {
  try {
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([...ids].slice(-DISMISSED_KEEP)));
  } catch {
    // Storage blocked: a put-off pop-up comes back after a reload, nothing worse.
  }
}
