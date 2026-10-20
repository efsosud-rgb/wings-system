/** Small formatters the CRM screens share; the API sends ISO strings and cents. */

const brl = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  maximumFractionDigits: 0,
});
const brlCents = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const money = (cents: number | null | undefined, exact = false): string =>
  cents === null || cents === undefined ? '—' : (exact ? brlCents : brl).format(cents / 100);

/** "R$ 12,5 mil" for the column headers; "R$ 1.234" below ten thousand. */
export function moneyShort(cents: number): string {
  const value = cents / 100;
  if (value >= 1_000_000)
    return `R$ ${(value / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mi`;
  if (value >= 10_000)
    return `R$ ${(value / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} mil`;
  return brl.format(value);
}

export const formatPhone = (phone: string | null | undefined): string => {
  if (!phone) return '—';
  const match = /^55(\d{2})(\d{4,5})(\d{4})$/.exec(phone);
  return match ? `(${match[1]}) ${match[2]}-${match[3]}` : phone;
};

/**
 * The person's chat in whatever WhatsApp is signed in on this device (the seller's own app,
 * Desktop or Web), optionally with a text already written that the seller still sends.
 */
export const waMeUrl = (phone: string, text?: string): string =>
  `https://wa.me/${phone.replace(/\D/g, '')}${text ? `?text=${encodeURIComponent(text)}` : ''}`;

export const formatDate = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleDateString('pt-BR') : '—';

/** A calendar day (`AAAA-MM-DD`) as `DD/MM/AAAA`, with no time zone shifting it to the day before. */
export const formatDay = (day: string | null | undefined): string => {
  const parts = day?.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return parts ? `${parts[3]}/${parts[2]}/${parts[1]}` : '—';
};

export const formatDateTime = (iso: string | null | undefined): string =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—';

const BRASILIA = 'America/Sao_Paulo';

/** `07/10/2026 às 14:32` in Brasília time, whatever the viewer's own time zone. */
export function formatEntered(iso: string | null | undefined): string {
  if (!iso) return '—';
  const at = new Date(iso);
  const day = at.toLocaleDateString('pt-BR', {
    timeZone: BRASILIA,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  const time = at.toLocaleTimeString('pt-BR', {
    timeZone: BRASILIA,
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${day} às ${time}`;
}

/** The same moment for a table cell: `07/10/2026 14:32`. */
export const formatEnteredShort = (iso: string | null | undefined): string =>
  formatEntered(iso).replace(' às ', ' ');

/** "3 d", "5 h", "12 min": how long since. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const minutes = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} h`;
  return `${Math.round(hours / 24)} d`;
}

/** "hoje 14:30", "amanhã 09:00", "seg 10:00", "12/10". */
export function dueLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const time = date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const diff = Math.round((day(date) - day(now)) / 86_400_000);
  if (diff === 0) return `hoje ${time}`;
  if (diff === 1) return `amanhã ${time}`;
  if (diff === -1) return `ontem ${time}`;
  if (diff > 1 && diff < 7)
    return `${date.toLocaleDateString('pt-BR', { weekday: 'short' }).replace('.', '')} ${time}`;
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
}

/** The tone of a stage by its position (background and text), cycling through the eight tokens. */
export const stageTone = (position: number): Record<string, string> => {
  const n = ((position - 1) % 8) + 1;
  return { '--arrow': `var(--stage-${n})`, '--arrow-fg': `var(--stage-${n}-fg)` };
};

export const isPast = (iso: string | null | undefined, now = Date.now()) =>
  Boolean(iso) && new Date(iso!).getTime() < now;

/** The local-input value of a Date (`datetime-local`). */
export const toLocalInput = (date: Date) => {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

/**
 * "1.234,56" typed -> cents; empty -> null; nonsense -> undefined. A dot that only groups
 * thousands ("25.000", "1.500.000") is Brazilian typing, not a decimal point: 25.000 is
 * R$ 25.000,00, never R$ 25,00. Same rule as `parseMoneyCents` in the API's CSV import.
 */
export function parseMoney(text: string): number | null | undefined {
  const raw = text.replace(/[R$\s]/g, '');
  if (!raw) return null;
  const value = Number(normalizeMoney(raw));
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : undefined;
}

function normalizeMoney(raw: string): string {
  if (raw.includes(',') && raw.lastIndexOf(',') > raw.lastIndexOf('.'))
    return raw.replace(/\./g, '').replace(',', '.');
  const plain = raw.replace(/,/g, '');
  return /^\d{1,3}(\.\d{3})+$/.test(plain) ? plain.replace(/\./g, '') : plain;
}
