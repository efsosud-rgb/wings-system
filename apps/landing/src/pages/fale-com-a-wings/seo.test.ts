import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { SITE_FORM_REVENUE_OPTIONS } from '@wings/shared';
import { describe, expect, it } from 'vitest';

/**
 * The diagnosis page (Eric, 27/10/2026): what search engines read, the FAQ
 * markup kept equal to the visible questions, and the revenue options equal to
 * the ones the API keeps.
 */

const app = resolve(import.meta.dirname, '../../..');
const page = readFileSync(resolve(app, 'fale-com-a-wings/index.html'), 'utf8');
const form = readFileSync(resolve(app, 'src/pages/fale-com-a-wings/form.html'), 'utf8');

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
const attr = (pattern: RegExp) => pattern.exec(page)?.[1]?.replace(/\s+/g, ' ');
const TITLE = 'Diagnóstico gratuito de franqueabilidade | Wings Company';

describe('"Fale com a Wings" for search engines', () => {
  it('has the title, the description, the canonical address and the share card', () => {
    expect(attr(/<title>([^<]+)<\/title>/)).toBe(TITLE);
    const description = attr(/<meta\s+name="description"\s+content="([^"]+)"/);
    for (const words of ['Formatação de franquias', 'diagnóstico gratuito', 'Rio de Janeiro']) {
      expect(description).toContain(words);
    }
    expect(attr(/<link rel="canonical" href="([^"]+)"/)).toBe('https://fale.wingscompany.com.br/');
    expect(attr(/<meta property="og:title" content="([^"]+)"/)).toBe(TITLE);
    expect(attr(/<meta\s+property="og:description"\s+content="([^"]+)"/)).toContain(
      'diagnóstico gratuito',
    );
  });

  it('opens with the offer and who it is for', () => {
    expect(text(/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(page)?.[1] ?? '')).toBe(
      'Diagnóstico gratuito de franqueabilidade',
    );
    expect(page).toContain('Para empresas validadas que querem crescer com franquias.');
  });

  it('shows only the numbers the Wings site publishes', () => {
    const proof = /<ul class="proof-list">([\s\S]*?)<\/ul>/.exec(page)?.[1] ?? '';
    expect([...proof.matchAll(/<li>([\s\S]*?)<\/li>/g)].map((m) => text(m[1] ?? ''))).toEqual([
      '+1.400marcas formatadas',
      '+30 anosde experiência em varejo e franchising',
    ]);
  });

  it('marks up the same five questions and answers it shows, with no price or deadline', () => {
    const visible = [
      ...page.matchAll(/<details>\s*<summary>([^<]+)<\/summary>\s*<p>([^<]+)<\/p>/g),
    ].map((m) => ({ q: text(m[1] ?? ''), a: text(m[2] ?? '') }));
    const blocks = [...page.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
    const faq = blocks
      .map((m) => JSON.parse(m[1] ?? 'null') as { '@type'?: string; mainEntity?: unknown[] })
      .find((ld) => ld?.['@type'] === 'FAQPage');
    const marked = (faq?.mainEntity ?? []).map((entry) => {
      const item = entry as { name: string; acceptedAnswer: { text: string } };
      return { q: item.name, a: item.acceptedAnswer.text };
    });
    expect(visible).toHaveLength(5);
    expect(marked).toEqual(visible);
    for (const { a } of visible) expect(a).not.toMatch(/\d|R\$/);
  });
});

describe('the form', () => {
  it('offers the revenue bands the API keeps, by the same codes and texts', () => {
    const select = /<select id="f-fat"[^>]*>([\s\S]*?)<\/select>/.exec(form)?.[1] ?? '';
    const options = [...select.matchAll(/<option value="([^"]*)">([^<]+)<\/option>/g)]
      .filter((m) => m[1])
      .map((m) => [m[1], m[2]]);
    expect(Object.fromEntries(options)).toEqual(SITE_FORM_REVENUE_OPTIONS);
    expect(options).toHaveLength(Object.keys(SITE_FORM_REVENUE_OPTIONS).length);
  });
});
