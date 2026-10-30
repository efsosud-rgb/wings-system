/**
 * The parts of a lead's e-mail the deal keeps (t083): who wrote it, and the text without the older
 * messages it quotes. Mail clients quote in a few known ways (Gmail's "Em …, … escreveu:", Outlook's
 * "De: … Enviado: …", "-----Original Message-----", lines starting with ">"); the text is cut at
 * the first of them. When nothing of the kind is found, the whole text stays.
 */

export const RECEIVED_TEXT_MAX = 20_000;

/** "Name <a@b.c>" or "a@b.c" → the address in lower case, and the name without quotes. */
export function parseFrom(
  header: string | undefined,
): { email: string; name: string | null } | null {
  if (!header) return null;
  const angled = /^\s*(.*?)\s*<([^<>\s]+@[^<>\s]+)>\s*$/.exec(header);
  const email = (angled?.[2] ?? header).trim().toLowerCase();
  if (!/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email)) return null;
  const name = angled?.[1]?.replace(/^"(.*)"$/, '$1').trim() || null;
  return { email, name };
}

const ATTRIBUTION = /^\s*(on|em)\s.*(wrote|escreveu)\s*:\s*$/i;
const ATTRIBUTION_START = /^\s*(on|em)\s.{4,}/i;
const ATTRIBUTION_END = /(wrote|escreveu)\s*:\s*$/i;
const ORIGINAL =
  /^\s*-{2,}\s*(original message|mensagem original|forwarded message|mensagem encaminhada)/i;
const OUTLOOK_FROM = /^\s*\**(de|from)\s*:\**\s/i;
const OUTLOOK_NEXT = /^\s*\**(enviad[oa]|sent|date|data|para|to)\s*:/i;

/** Where the quoted part starts, or -1. */
function quoteStart(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^\s*>/.test(line) || ATTRIBUTION.test(line) || ORIGINAL.test(line)) return i;
    // Gmail wraps a long attribution in two lines.
    if (ATTRIBUTION_START.test(line) && ATTRIBUTION_END.test(lines[i + 1] ?? '')) return i;
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 4).some((l) => OUTLOOK_NEXT.test(l)))
      return i;
  }
  return -1;
}

/** The text as the lead wrote it this time; the whole text when the cut would leave nothing. */
export function withoutQuotes(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = quoteStart(lines);
  const kept = (start === -1 ? lines : lines.slice(0, start)).join('\n').trim();
  return (kept || text.trim()).slice(0, RECEIVED_TEXT_MAX);
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  nbsp: ' ',
  '#39': "'",
};

/** A message that only came as HTML: Gmail's quote block dropped, the tags turned into lines. */
export function textOfHtml(html: string): string {
  const cut = html.search(/<div[^>]*class="[^"]*gmail_quote|<blockquote/i);
  return (cut === -1 ? html : html.slice(0, cut))
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>|<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|nbsp|#39);/g, (_, name: string) => ENTITIES[name] ?? '')
    .replace(/\n{3,}/g, '\n\n');
}
