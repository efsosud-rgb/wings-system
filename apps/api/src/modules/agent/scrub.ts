/**
 * The agent never sees a token, a phone number or a CPF.
 *
 * The read tools select only columns that cannot hold one. This is the second
 * line: free text — what a person typed into the chat or the builder, an
 * alert's detail, a campaign name — passes through here before it reaches the
 * model or is stored. Bare digit runs are left alone on purpose: campaign and
 * account ids are digit runs too, and the agent needs them.
 */

const PATTERNS: [RegExp, string][] = [
  // CPF, formatted: 123.456.789-09
  [/\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/g, '[CPF removido]'],
  // Brazilian phones: +55 11 91234-5678, (11) 91234-5678, 11 1234-5678, +5511912345678
  [/\+55[\s.-]?\(?\d{2}\)?[\s.-]?9?\d{4}[\s.-]?\d{4}\b/g, '[telefone removido]'],
  [/\(?\b\d{2}\)?[\s.-]?9?\d{4}-\d{4}\b/g, '[telefone removido]'],
  // E-mail addresses are personal data too.
  [/\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g, '[e-mail removido]'],
  // Credentials: Meta (EAA…), OpenRouter/OpenAI-style (sk-…), bearer values,
  // and any long unbroken secret-looking run that mixes letters and digits.
  [/\bEAA[A-Za-z0-9]{20,}\b/g, '[token removido]'],
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, '[token removido]'],
  [/\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi, '[token removido]'],
  [/\b(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}\b/g, '[token removido]'],
];

export function scrubSensitive(text: string): string {
  return PATTERNS.reduce((result, [pattern, label]) => result.replace(pattern, label), text);
}

/** Scrubs every string inside a JSON-like value; keys are left as they are. */
export function scrubDeep<T>(value: T): T {
  if (typeof value === 'string') return scrubSensitive(value) as T;
  if (Array.isArray(value)) return value.map(scrubDeep) as T;
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, scrubDeep(item)]),
    ) as T;
  }
  return value;
}
