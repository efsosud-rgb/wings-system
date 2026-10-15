import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../api/client.js';
import { captureFirstTouch, FIRST_TOUCH_COOKIE, readFirstTouch } from '../lib/site-tracking.js';

const get = vi.fn();
const post = vi.fn();
vi.mock('../api/client.js', async (original) => ({
  ...(await original<typeof import('../api/client.js')>()),
  api: {
    get: (path: string) => get(path),
    post: (path: string, body?: unknown) => post(path, body),
  },
}));

const { SiteFormPage } = await import('./SiteFormPage.js');

/** Turnstile simulated: renders at once and hands over a token. */
function fakeTurnstile() {
  window.turnstile = {
    render: (_element, options) => {
      options.callback('turnstile-token');
      return 'w1';
    },
    reset: () => undefined,
  };
}

beforeEach(() => {
  get.mockReset().mockImplementation(async (path: string) => {
    if (path === '/public/site-forms/cenoritas')
      return {
        slug: 'cenoritas',
        brand: 'Cenoritas',
        turnstileSiteKey: '0x4AAA-site',
        instagram: '@cenoritas.gourmet',
        form: null,
        pipeline: 'expansao',
        tracking: { metaPixelId: null, googleAdsConversion: null },
      };
    if (path === '/public/site-forms/formatacao')
      return {
        slug: 'formatacao',
        brand: 'Wings Company',
        turnstileSiteKey: '0x4AAA-site',
        instagram: null,
        form: {
          qualifier: null,
          privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
          thankYou: {
            title: 'Recebemos os seus dados',
            body: 'O time da Wings entra em contato pelo WhatsApp em até um dia útil.',
            buttonText: 'Conhecer a Wings',
            buttonUrl: 'https://wingscompany.com.br/',
          },
        },
        pipeline: 'formatacao',
        tracking: {
          metaPixelId: '1116678872845520',
          googleAdsConversion: 'AW-123456789/AbCdEfGhIj',
        },
      };
    if (path === '/public/site-forms/fale-com-a-wings')
      return {
        slug: 'fale-com-a-wings',
        brand: 'Wings Company',
        turnstileSiteKey: '0x4AAA-site',
        instagram: null,
        form: {
          qualifier: {
            question: 'O que você procura?',
            options: ['Transformar meu negócio em franquia', 'Ainda não sei'],
          },
          qualifierValues: [
            { value: 'formatacao', option: 'Transformar meu negócio em franquia' },
            { value: 'nao-sei', option: 'Ainda não sei' },
          ],
          requiredFields: ['email', 'companyName', 'instagram', 'qualifierAnswer'],
          consentText: 'Li a Política de Privacidade e autorizo a Wings a falar comigo.',
          privacyPolicyUrl: 'https://wingscompany.com.br/politica-de-privacidade/',
          thankYou: {
            title: 'Obrigado!',
            body: 'A Wings vai falar com você.',
            buttonText: 'Conhecer a Wings',
            buttonUrl: 'https://wingscompany.com.br/',
          },
        },
        whatsappUrl: null,
        pipeline: 'formatacao',
        tracking: { metaPixelId: null, googleAdsConversion: null },
      };
    throw new ApiError(404, { error: 'not_found', message: 'Formulário não encontrado.' });
  });
  post.mockReset().mockResolvedValue({ ok: true, whatsappUrl: null });
  document.cookie = `${FIRST_TOUCH_COOKIE}=; Max-Age=0; Path=/`;
  fakeTurnstile();
});
afterEach(() => {
  cleanup();
  delete window.turnstile;
  // The tags' scripts and globals of one test never reach the next.
  document.querySelectorAll('script').forEach((script) => script.remove());
  delete window.fbq;
  delete window._fbq;
  delete window.gtag;
  delete window.dataLayer;
});

// Read through a function: the `delete window.fbq` at the top of a test would otherwise narrow the type to never.
const pixelQueue = () => window.fbq?.queue;

function renderAt(path: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/lp/:slug" element={<SiteFormPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('site form page (T5)', () => {
  it('sends the person, the Turnstile token and the first touch kept in the cookie', async () => {
    document.cookie = `${FIRST_TOUCH_COOKIE}=${encodeURIComponent(
      JSON.stringify({ utm_source: 'facebook', utm_campaign: 'expansao_out26', fbclid: 'fb.1' }),
    )}; Path=/`;
    renderAt('/lp/cenoritas');
    expect(await screen.findByText('Seja um franqueado Cenoritas')).toBeTruthy();
    fireEvent.input(screen.getByLabelText(/^Nome(?! da)/), { target: { value: 'Pessoa Teste' } });
    fireEvent.input(screen.getByLabelText(/^WhatsApp/), { target: { value: '21999990001' } });
    fireEvent.input(screen.getByLabelText(/^Nome da empresa/), {
      target: { value: 'Empresa Teste' },
    });
    fireEvent.input(screen.getByLabelText(/^Instagram/), { target: { value: '@empresa.teste' } });
    fireEvent.input(screen.getByLabelText(/^Site da empresa/), {
      target: { value: 'empresa-teste.com.br' },
    });
    expect(screen.queryByLabelText(/^E-mail/)).toBeNull();
    expect(screen.queryByLabelText(/^CNPJ/)).toBeNull();
    fireEvent.click(screen.getByRole('checkbox'));
    const send = screen.getByRole('button', { name: 'Quero ser franqueado' }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/public/site-forms/cenoritas');
    expect(body).toMatchObject({
      name: 'Pessoa Teste',
      phone: '21999990001',
      companyName: 'Empresa Teste',
      instagram: '@empresa.teste',
      siteUrl: 'empresa-teste.com.br',
      consent: true,
      turnstileToken: 'turnstile-token',
      website: '',
      tracking: { utm_source: 'facebook', utm_campaign: 'expansao_out26', fbclid: 'fb.1' },
    });
    // The standard form's five questions and nothing else: no e-mail, no CNPJ.
    expect(body).not.toHaveProperty('email');
    expect(await screen.findByText(/Recebemos seus dados/)).toBeTruthy();
    expect(screen.getByRole('link', { name: '@cenoritas.gourmet' }).getAttribute('href')).toBe(
      'https://www.instagram.com/cenoritas.gourmet/',
    );
    // No link from the server: only the thanks.
    expect(screen.queryByRole('link', { name: /WhatsApp/ })).toBeNull();
  });

  it('offers the Wings WhatsApp for the brand after sending, when the server gives one', async () => {
    post.mockResolvedValueOnce({
      ok: true,
      whatsappUrl: 'https://wa.me/5521999470288?text=SITE22',
    });
    renderAt('/lp/cenoritas');
    await screen.findByText('Seja um franqueado Cenoritas');
    fireEvent.input(screen.getByLabelText(/^Nome(?! da)/), { target: { value: 'Pessoa Teste' } });
    fireEvent.input(screen.getByLabelText(/^WhatsApp/), { target: { value: '21999990001' } });
    fireEvent.input(screen.getByLabelText(/^Nome da empresa/), {
      target: { value: 'Empresa Teste' },
    });
    fireEvent.input(screen.getByLabelText(/^Instagram/), { target: { value: '@empresa.teste' } });
    fireEvent.input(screen.getByLabelText(/^Site da empresa/), {
      target: { value: 'empresa-teste.com.br' },
    });
    fireEvent.click(screen.getByRole('checkbox'));
    const send = screen.getByRole('button', { name: 'Quero ser franqueado' }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    const link = await screen.findByRole('link', {
      name: 'Falar sobre a franquia Cenoritas no WhatsApp',
    });
    expect(link.getAttribute('href')).toBe('https://wa.me/5521999470288?text=SITE22');
    expect(link.getAttribute('rel')).toBe('noopener noreferrer');
  });

  it('does not send without the consent', async () => {
    renderAt('/lp/cenoritas');
    await screen.findByText('Seja um franqueado Cenoritas');
    fireEvent.input(screen.getByLabelText(/^Nome(?! da)/), { target: { value: 'Pessoa Teste' } });
    fireEvent.input(screen.getByLabelText(/^WhatsApp/), { target: { value: '21999990001' } });
    fireEvent.input(screen.getByLabelText(/^Nome da empresa/), {
      target: { value: 'Empresa Teste' },
    });
    fireEvent.input(screen.getByLabelText(/^Instagram/), { target: { value: '@empresa.teste' } });
    fireEvent.input(screen.getByLabelText(/^Site da empresa/), {
      target: { value: 'empresa-teste.com.br' },
    });
    const send = screen.getByRole('button', { name: 'Quero ser franqueado' }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText('É preciso autorizar o contato')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('a Formatação page talks to the business owner, loads the tags it has ids for and fires them on a sent form', async () => {
    delete window.fbq;
    delete window.gtag;
    window.dataLayer = [];
    renderAt('/lp/formatacao');
    expect(await screen.findByText('Transforme a sua empresa em franquia')).toBeTruthy();
    expect(screen.getByText(/formatação da minha empresa em franquia/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Política de Privacidade' }).getAttribute('href')).toBe(
      'https://wingscompany.com.br/politica-de-privacidade/',
    );
    // Both scripts asked for, the pixel initialised with the page view, gtag configured.
    await waitFor(() =>
      expect(
        document.querySelector('script[src="https://connect.facebook.net/en_US/fbevents.js"]'),
      ).toBeTruthy(),
    );
    expect(
      document.querySelector(
        'script[src="https://www.googletagmanager.com/gtag/js?id=AW-123456789"]',
      ),
    ).toBeTruthy();
    expect(pixelQueue()).toEqual([
      ['init', '1116678872845520'],
      ['track', 'PageView'],
    ]);
    const configured = (window.dataLayer ?? []).map((entry) =>
      Array.from(entry as ArrayLike<unknown>),
    );
    expect(configured[1]).toEqual(['config', 'AW-123456789']);

    fireEvent.input(screen.getByLabelText(/^Nome(?! da)/), { target: { value: 'Pessoa Teste' } });
    fireEvent.input(screen.getByLabelText(/^WhatsApp/), { target: { value: '21999990001' } });
    fireEvent.input(screen.getByLabelText(/^Nome da empresa/), {
      target: { value: 'Padaria Teste' },
    });
    fireEvent.input(screen.getByLabelText(/^Instagram/), { target: { value: '@padaria.teste' } });
    fireEvent.input(screen.getByLabelText(/^Site da empresa/), { target: { value: 'não tenho' } });
    fireEvent.click(screen.getByRole('checkbox'));
    const send = screen.getByRole('button', {
      name: 'Quero formatar minha franquia',
    }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));
    fireEvent.click(send);
    expect(await screen.findByText('Recebemos os seus dados')).toBeTruthy();
    expect(pixelQueue()?.at(-1)).toEqual(['track', 'Lead']);
    const events = (window.dataLayer ?? []).map((entry) => Array.from(entry as ArrayLike<unknown>));
    expect(events.at(-1)).toEqual(['event', 'conversion', { send_to: 'AW-123456789/AbCdEfGhIj' }]);
    // Nothing typed reaches the tags.
    expect(JSON.stringify([pixelQueue(), events])).not.toContain('Pessoa Teste');
  });

  it("asks and requires the e-mail when the page's form requires it, with the page's own consent line", async () => {
    renderAt('/lp/fale-com-a-wings');
    expect(await screen.findByText('Transforme a sua empresa em franquia')).toBeTruthy();
    // The line the lead keeps, not the funnel's.
    expect(
      screen.getByText('Li a Política de Privacidade e autorizo a Wings a falar comigo.'),
    ).toBeTruthy();
    expect(screen.queryByText(/formatação da minha empresa em franquia/)).toBeNull();
    const email = screen.getByLabelText(/^E-mail/) as HTMLInputElement;
    expect(email.type).toBe('email');
    fireEvent.input(screen.getByLabelText(/^Nome(?! da)/), { target: { value: 'Pessoa Teste' } });
    fireEvent.input(screen.getByLabelText(/^WhatsApp/), { target: { value: '21999990001' } });
    fireEvent.input(screen.getByLabelText(/^Nome da empresa/), {
      target: { value: 'Empresa Teste' },
    });
    fireEvent.input(screen.getByLabelText(/^Instagram/), { target: { value: '@empresa.teste' } });
    fireEvent.input(screen.getByLabelText(/^Site da empresa/), { target: { value: 'não tenho' } });
    fireEvent.click(screen.getByLabelText('Ainda não sei'));
    fireEvent.click(screen.getByRole('checkbox'));
    const send = screen.getByRole('button', {
      name: 'Quero formatar minha franquia',
    }) as HTMLButtonElement;
    await waitFor(() => expect(send.disabled).toBe(false));

    // Nothing typed: asked for, nothing sent.
    fireEvent.click(send);
    expect(await screen.findByText('Informe o seu e-mail')).toBeTruthy();
    // Typed and erased: still missing, not "invalid".
    fireEvent.input(email, { target: { value: 'x' } });
    fireEvent.input(email, { target: { value: '  ' } });
    fireEvent.click(send);
    await waitFor(() => expect(screen.getByText('Informe o seu e-mail')).toBeTruthy());
    fireEvent.input(email, { target: { value: 'pessoa' } });
    fireEvent.click(send);
    expect(await screen.findByText('E-mail inválido')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();

    fireEvent.input(email, { target: { value: 'pessoa.teste@example.com' } });
    fireEvent.click(send);
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/public/site-forms/fale-com-a-wings');
    // The option's text: the API takes it for the option's code.
    expect(body).toMatchObject({
      email: 'pessoa.teste@example.com',
      qualifierAnswer: 'Ainda não sei',
      consent: true,
    });
    expect(await screen.findByText('Obrigado!')).toBeTruthy();
  });

  it('loads no tag when the API hands over no id', async () => {
    delete window.fbq;
    delete window.gtag;
    renderAt('/lp/cenoritas');
    await screen.findByText('Seja um franqueado Cenoritas');
    expect(document.querySelector('script[src^="https://connect.facebook.net"]')).toBeNull();
    expect(document.querySelector('script[src^="https://www.googletagmanager.com"]')).toBeNull();
    expect(window.fbq).toBeUndefined();
  });

  it('says so for a page that does not take the form, and blocks sending while Turnstile is unset', async () => {
    renderAt('/lp/nao-existe');
    expect(await screen.findByText('Página não encontrada')).toBeTruthy();
    cleanup();
    get.mockImplementation(async () => ({
      slug: 'cenoritas',
      brand: 'Cenoritas',
      turnstileSiteKey: null,
      instagram: null,
      form: null,
      pipeline: 'expansao',
      tracking: { metaPixelId: null, googleAdsConversion: null },
    }));
    renderAt('/lp/cenoritas');
    expect(await screen.findByText('O formulário ainda está em configuração.')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Quero ser franqueado' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });
});

describe('first touch cookie', () => {
  it('keeps the first visit (UTMs, ad ids, another site as referrer), and a later visit does not replace it', () => {
    const doc = { cookie: '', referrer: 'https://www.instagram.com/p/xyz?igsh=1' };
    const first = captureFirstTouch(
      doc,
      'https://staging.wingssystem.online/lp/cenoritas?utm_source=ig&campaign_id=120&email=x@y.com',
    );
    expect(first).toEqual({
      utm_source: 'ig',
      campaign_id: '120',
      referrer: 'https://www.instagram.com/p/xyz',
    });
    expect(doc.cookie).toContain(`${FIRST_TOUCH_COOKIE}=`);
    const kept = readFirstTouch(doc.cookie.split(';')[0]!);
    expect(kept).toEqual(first);

    const later = captureFirstTouch(
      { cookie: doc.cookie.split(';')[0]!, referrer: '' },
      'https://staging.wingssystem.online/lp/cenoritas?utm_source=google',
    );
    expect(later.utm_source).toBe('ig');
  });

  it('ignores a referrer from the same site', () => {
    const doc = { cookie: '', referrer: 'https://staging.wingssystem.online/outra' };
    expect(captureFirstTouch(doc, 'https://staging.wingssystem.online/lp/x')).toEqual({});
  });
});
