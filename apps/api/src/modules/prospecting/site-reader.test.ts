import { EventEmitter } from 'node:events';
import https from 'node:https';
import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { guardedLookup, readPublicPage, type PageTransport } from '../../lib/public-probe.js';
import {
  aboutPageOf,
  contactPageOf,
  extractContacts,
  readCompanySite,
  robotsAllows,
} from './site-reader.js';

/** A made-up company's site, served by a transport that records what was asked. */
function site(pages: Record<string, { status?: number; location?: string; body?: string }>) {
  const asked: string[] = [];
  const caps: Record<string, number> = {};
  const transport: PageTransport = async (url, limits) => {
    asked.push(url.href);
    caps[url.pathname] = limits.maxBytes;
    expect(limits.userAgent).toBe('WingsSystem-Prospeccao/1.0');
    const page = pages[url.href];
    if (!page) return { status: 404, location: null, body: '' };
    return {
      status: page.status ?? 200,
      location: page.location ?? null,
      body: (page.body ?? '').slice(0, limits.maxBytes),
    };
  };
  return { transport, asked, caps };
}

const HOME = `<!doctype html><html><body>
  <a href="https://www.instagram.com/p/AbCdEf/">um post</a>
  <a href="https://instagram.com/hamburgueria.teste/">Instagram</a>
  <a href="https://www.facebook.com/sharer/sharer.php?u=x">compartilhar</a>
  <a href="https://pt-br.facebook.com/HamburgueriaTeste">Facebook</a>
  <a href="https://br.linkedin.com/company/hamburgueria-teste">LinkedIn</a>
  <a href="https://api.whatsapp.com/send?l=pt&amp;phone=5521990000001">WhatsApp</a>
  <img src="/img/logo@2x.png">
  <p>Escreva para contato@hamburgueria-teste.com.br</p>
  <a href="/fale-conosco">Fale conosco</a>
</body></html>`;

describe('robots.txt', () => {
  const robots = `
User-agent: *
Disallow: /admin
Allow: /admin/publico
Disallow: /*.pdf$

User-agent: WingsSystem-Prospeccao
User-agent: outro-robo
Disallow: /contato
`;

  it('uses our own group over *, the longest rule wins, Allow wins a tie', () => {
    expect(robotsAllows(robots, '/contato')).toBe(false);
    expect(robotsAllows(robots, '/admin')).toBe(true); // our group has no /admin rule
    const star = 'User-agent: *\nDisallow: /admin\nAllow: /admin/publico\nDisallow: /*.pdf$';
    expect(robotsAllows(star, '/admin/x')).toBe(false);
    expect(robotsAllows(star, '/admin/publico/x')).toBe(true);
    expect(robotsAllows(star, '/cardapio.pdf')).toBe(false);
    expect(robotsAllows(star, '/cardapio.pdf?v=2')).toBe(true);
    expect(robotsAllows(star, '/')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /\nAllow: /', '/x')).toBe(true);
  });

  it('an empty Disallow allows everything; a file without groups allows everything', () => {
    expect(robotsAllows('User-agent: *\nDisallow:', '/qualquer')).toBe(true);
    expect(robotsAllows('', '/')).toBe(true);
    expect(robotsAllows('User-agent: *\nDisallow: /', '/')).toBe(false);
  });

  it("takes linear time on a site's hostile rules and paths", () => {
    const started = performance.now();
    expect(robotsAllows('User-agent: *\nDisallow: /a*a*a*a*a*b$', `/${'a'.repeat(500)}`)).toBe(
      true,
    );
    const heavy = `User-agent: *\n${`Disallow: /*${'a'.repeat(300)}*${'*a'.repeat(200)}b\n`.repeat(100)}`;
    expect(robotsAllows(heavy, `/${'a'.repeat(511)}`)).toBe(true);
    // Too long to try against someone else's rules: not read.
    expect(robotsAllows('User-agent: *\nAllow: /', `/${'a'.repeat(2000)}`)).toBe(false);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('what a page gives', () => {
  it('takes the first link of each kind, skipping posts, share buttons and placeholders', () => {
    expect(extractContacts(HOME)).toEqual({
      instagram: 'https://www.instagram.com/hamburgueria.teste/',
      facebook: 'https://www.facebook.com/HamburgueriaTeste',
      linkedin: 'https://www.linkedin.com/company/hamburgueria-teste',
      whatsapp: 'https://wa.me/5521990000001',
      email: 'contato@hamburgueria-teste.com.br',
    });
  });

  it('prefers a mailto, and ignores image names and placeholder e-mails', () => {
    expect(
      extractContacts(
        '<img src="a@2x.png"> seuemail@gmail.com x@sentry.io <a href="mailto:Vendas@Empresa-Teste.com.br?subject=oi">e-mail</a>',
      ),
    ).toEqual({ email: 'vendas@empresa-teste.com.br' });
    expect(extractContacts('<a href="https://wa.me/5521990000002">zap</a>')).toEqual({
      whatsapp: 'https://wa.me/5521990000002',
    });
  });

  it('finds one contact page on the same host', () => {
    const base = new URL('https://hamburgueria-teste.example.com.br/');
    expect(contactPageOf(HOME, base)?.href).toBe(
      'https://hamburgueria-teste.example.com.br/fale-conosco',
    );
    expect(
      contactPageOf('<a href="https://outro.example.com/contato">Contato</a>', base),
    ).toBeNull();
    expect(contactPageOf('<a href="mailto:contato@x.com.br">contato</a>', base)).toBeNull();
    expect(contactPageOf('<a href="/sobre">Atendimento</a>', base)?.pathname).toBe('/sobre');
    expect(
      contactPageOf('<A class="x" HREF="/fale"><span>Contato</span></a>', base)?.pathname,
    ).toBe('/fale');
  });

  it('walks a hostile megabyte in linear time', () => {
    const base = new URL('https://hamburgueria-teste.example.com.br/');
    const started = performance.now();
    expect(contactPageOf('<a href="x" '.repeat(85_000), base)).toBeNull();
    expect(contactPageOf(`<a href="/x">${'<'.repeat(1500)}</a>`.repeat(650), base)).toBeNull();
    const last = `${'<a href="/x">x'.repeat(70_000)}${' '.repeat(3000)}<a href="/contato">Contato</a>`;
    expect(contactPageOf(last, base)?.pathname).toBe('/contato');
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('reading a company site', () => {
  const origin = 'https://hamburgueria-teste.example.com.br';

  it('reads the home page and one contact page, robots.txt first', async () => {
    const { transport, asked, caps } = site({
      [`${origin}/robots.txt`]: { body: 'User-agent: *\nDisallow: /admin' },
      [`${origin}/`]: { body: HOME.replace(/contato@[^<]+/, '') },
      [`${origin}/fale-conosco`]: {
        body: '<a href="mailto:pedidos@hamburgueria-teste.com.br">e-mail</a>',
      },
    });
    const reading = await readCompanySite(`${origin}/`, transport);
    expect(asked).toEqual([`${origin}/robots.txt`, `${origin}/`, `${origin}/fale-conosco`]);
    expect(caps).toEqual({ '/robots.txt': 100_000, '/': 1_000_000, '/fale-conosco': 1_000_000 });
    expect(reading.pagesRead).toBe(2);
    expect(reading.skipped).toEqual([]);
    expect(reading.found.email).toBe('pedidos@hamburgueria-teste.com.br');
    expect(reading.found.instagram).toBe('https://www.instagram.com/hamburgueria.teste/');
  });

  it('reads nothing a robots.txt forbids, and nothing when robots.txt fails with 5xx', async () => {
    const forbidden = site({
      [`${origin}/robots.txt`]: { body: 'User-agent: *\nDisallow: /' },
      [`${origin}/`]: { body: HOME },
    });
    const refused = await readCompanySite(`${origin}/`, forbidden.transport);
    expect(forbidden.asked).toEqual([`${origin}/robots.txt`]);
    expect(refused).toEqual({
      found: {},
      pagesRead: 0,
      skipped: ['Página inicial: o robots.txt do site não permite a leitura.'],
    });

    const broken = site({
      [`${origin}/robots.txt`]: { status: 503 },
      [`${origin}/`]: { body: HOME },
    });
    const down = await readCompanySite(`${origin}/`, broken.transport);
    expect(broken.asked).toEqual([`${origin}/robots.txt`]);
    expect(down.pagesRead).toBe(0);
    expect(down.skipped[0]).toMatch(/robots\.txt não respondeu/);
  });

  it('asks robots.txt again where a redirect leads, and stops there when it forbids', async () => {
    const other = 'https://www.hamburgueria-teste.example.com.br';
    const { transport, asked } = site({
      [`${origin}/`]: { status: 301, location: `${other}/area-restrita` },
      [`${other}/robots.txt`]: { body: 'User-agent: *\nDisallow: /area-restrita' },
      [`${other}/area-restrita`]: { body: '<a href="https://wa.me/5521990000005">x</a>' },
    });
    const reading = await readCompanySite(`${origin}/`, transport);
    expect(asked).toEqual([`${origin}/robots.txt`, `${origin}/`, `${other}/robots.txt`]);
    expect(reading).toEqual({
      found: {},
      pagesRead: 0,
      skipped: [
        'Página inicial: o site redireciona para um endereço que o robots.txt não deixa ler.',
      ],
    });
  });

  it('no robots.txt (404) allows everything', async () => {
    const { transport } = site({
      [`${origin}/`]: { body: '<a href="https://wa.me/5521990000003">x</a>' },
    });
    const reading = await readCompanySite(`${origin}/`, transport);
    expect(reading.pagesRead).toBe(1);
    expect(reading.found).toEqual({ whatsapp: 'https://wa.me/5521990000003' });
  });

  it('keeps only the first megabyte of a page', async () => {
    const big = `${'a'.repeat(1_000_000)}<a href="https://wa.me/5521990000004">x</a>`;
    const { transport } = site({ [`${origin}/`]: { body: big } });
    const reading = await readCompanySite(`${origin}/`, transport);
    expect(reading.pagesRead).toBe(1);
    expect(reading.found).toEqual({});
  });
});

describe('SSRF: the reader never reaches our own network', () => {
  it.each([
    'http://127.0.0.1/',
    'http://10.0.0.1/',
    'http://169.254.169.254/latest/meta-data/',
    'http://[::1]/',
    'ftp://hamburgueria-teste.example.com.br/',
    'http://hamburgueria-teste.example.com.br:8080/',
    'http://postgres./',
  ])('refuses %s before any request', async (url) => {
    const { transport, asked } = site({});
    expect(
      await readPublicPage(url, { maxBytes: 10, timeoutMs: 100, userAgent: 'x', transport }),
    ).toEqual({ kind: 'blocked' });
    const reading = await readCompanySite(url, transport);
    expect(asked).toEqual([]);
    expect(reading.pagesRead).toBe(0);
    expect(reading.skipped[0]).toMatch(/endereço bloqueado/);
  });

  it('refuses a redirect from a public host to a private one, without following it', async () => {
    const { transport, asked } = site({
      'https://hamburgueria-teste.example.com.br/': {
        status: 302,
        location: 'http://169.254.169.254/latest/meta-data/',
      },
    });
    const result = await readPublicPage('https://hamburgueria-teste.example.com.br/', {
      maxBytes: 100,
      timeoutMs: 1000,
      userAgent: 'WingsSystem-Prospeccao/1.0',
      transport,
    });
    expect(result).toEqual({ kind: 'blocked' });
    expect(asked).toEqual(['https://hamburgueria-teste.example.com.br/']);
  });

  it('refuses a name that resolves to a private address (the connect-time lookup)', async () => {
    // The real transport connects through `guardedLookup`; here the name answers like localhost.
    const resolvesPrivate: PageTransport = () =>
      new Promise((_resolve, reject) => guardedLookup('localhost', {}, (error) => reject(error)));
    const result = await readPublicPage('https://empresa-falsa.example.com.br/', {
      maxBytes: 100,
      timeoutMs: 1000,
      userAgent: 'x',
      transport: resolvesPrivate,
    });
    expect(result).toEqual({ kind: 'blocked' });
  });

  it('the real transport connects through the guarded lookup and stops at the byte cap', async () => {
    let options: { lookup?: unknown } = {};
    // The network is off in tests: https.request answers here, as a server would.
    const request = vi.spyOn(https, 'request').mockImplementation(((
      _url: URL,
      given: { lookup?: unknown },
      onResponse: (response: Readable) => void,
    ) => {
      options = given;
      const answer = Object.assign(
        Readable.from([Buffer.alloc(600, 'a'), Buffer.alloc(600, 'b')]),
        { statusCode: 200, headers: {} },
      );
      return Object.assign(new EventEmitter(), {
        end: () => onResponse(answer),
        destroy: () => undefined,
      });
    }) as unknown as typeof https.request);
    try {
      const page = await readPublicPage('https://empresa-falsa.example.com.br/', {
        maxBytes: 1000,
        timeoutMs: 1000,
        userAgent: 'x',
      });
      expect(options.lookup).toBe(guardedLookup);
      expect(page).toMatchObject({ kind: 'ok', status: 200 });
      expect(page.kind === 'ok' && page.body).toBe(`${'a'.repeat(600)}${'b'.repeat(400)}`);
    } finally {
      request.mockRestore();
    }
  });
});

describe('timeout, retry and the pages searched (t086)', () => {
  const origin = 'https://padaria-teste.example.com.br';
  const insta = '<a href="https://www.instagram.com/padaria.teste/">Instagram</a>';

  /** A transport whose answers per URL are consumed in order; 'timeout' hangs past the deadline. */
  function scripted(script: Record<string, ('timeout' | 'error' | string)[]>) {
    const asked: { url: string; windowMs: number }[] = [];
    const transport: PageTransport = async (url, limits) => {
      asked.push({ url: url.href, windowMs: limits.deadline - Date.now() });
      const queue = script[url.href];
      const next = queue && queue.length > 1 ? queue.shift() : queue?.[0];
      if (next === 'timeout') throw new Error('timeout');
      if (next === 'error') throw new Error('ECONNRESET');
      if (next === undefined) return { status: 404, location: null, body: '' };
      return { status: 200, location: null, body: next };
    };
    return { transport, asked };
  }

  it('waits 12 seconds for each request, not 5', async () => {
    const { transport, asked } = scripted({ [`${origin}/`]: [insta] });
    await readCompanySite(`${origin}/`, { transport });
    expect(asked.every((a) => a.windowMs > 11_000 && a.windowMs <= 12_000)).toBe(true);
  });

  it('tries a page again after a timeout or a connection failure, once', async () => {
    const { transport, asked } = scripted({
      [`${origin}/robots.txt`]: ['error', ''],
      [`${origin}/`]: ['timeout', insta],
    });
    const reading = await readCompanySite(`${origin}/`, { transport });
    expect(reading.found.instagram).toBe('https://www.instagram.com/padaria.teste/');
    expect(asked.map((a) => a.url)).toEqual([
      `${origin}/robots.txt`,
      `${origin}/robots.txt`,
      `${origin}/`,
      `${origin}/`,
    ]);
    expect(reading.timedOut).toBeUndefined();
  });

  it('gives up after the second timeout and says 12 seconds and 2 tries, not 5 seconds', async () => {
    const { transport, asked } = scripted({
      [`${origin}/robots.txt`]: [''],
      [`${origin}/`]: ['timeout'],
    });
    const reading = await readCompanySite(`${origin}/`, { transport });
    expect(asked.filter((a) => a.url === `${origin}/`)).toHaveLength(2);
    expect(reading).toMatchObject({ found: {}, pagesRead: 0, timedOut: true });
    expect(reading.skipped).toEqual([
      'Página inicial: o site não respondeu em 12 segundos (2 tentativas).',
    ]);
    expect(JSON.stringify(reading)).not.toContain('5 segundos');
  });

  it('does not retry an answer: a 503 from robots.txt is asked once', async () => {
    const { transport, asked } = scripted({});
    const failing: PageTransport = async (url, limits) => {
      if (url.pathname === '/robots.txt') {
        asked.push({ url: url.href, windowMs: 0 });
        return { status: 503, location: null, body: '' };
      }
      return transport(url, limits);
    };
    const reading = await readCompanySite(`${origin}/`, { transport: failing });
    expect(asked).toHaveLength(1);
    expect(reading.pagesRead).toBe(0);
  });

  it('looks for the link on the home page footer, the contact page and the "sobre" page', async () => {
    const home = `<footer>${'<a href="/contato">Contato</a><a href="/sobre-nos">Sobre nós</a>'}</footer>`;
    const { transport, asked } = scripted({
      [`${origin}/robots.txt`]: [''],
      [`${origin}/`]: [home],
      [`${origin}/contato`]: ['<p>sem redes</p>'],
      [`${origin}/sobre-nos`]: [insta],
    });
    const reading = await readCompanySite(`${origin}/`, { transport });
    expect(reading.pagesRead).toBe(3);
    expect(reading.found.instagram).toBe('https://www.instagram.com/padaria.teste/');
    expect(asked.map((a) => a.url)).toContain(`${origin}/sobre-nos`);
    expect(aboutPageOf(home, new URL(`${origin}/`))?.pathname).toBe('/sobre-nos');
  });

  it('stops at the first Instagram link when the finder asks for only that', async () => {
    const home = `${insta}<a href="/contato">Contato</a><a href="/sobre">Sobre</a>`;
    const { transport, asked } = scripted({ [`${origin}/`]: [home] });
    const reading = await readCompanySite(`${origin}/`, { transport, stopAtInstagram: true });
    expect(reading.pagesRead).toBe(1);
    expect(asked.map((a) => new URL(a.url).pathname)).toEqual(['/robots.txt', '/']);
  });
});
