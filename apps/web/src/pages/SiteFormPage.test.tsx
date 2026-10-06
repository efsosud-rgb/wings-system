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
});

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
    fireEvent.input(screen.getByLabelText(/^E-mail/), { target: { value: 'pessoa@example.com' } });
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
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/public/site-forms/cenoritas');
    expect(body).toMatchObject({
      name: 'Pessoa Teste',
      email: 'pessoa@example.com',
      phone: '21999990001',
      companyName: 'Empresa Teste',
      instagram: '@empresa.teste',
      siteUrl: 'empresa-teste.com.br',
      consent: true,
      turnstileToken: 'turnstile-token',
      website: '',
      tracking: { utm_source: 'facebook', utm_campaign: 'expansao_out26', fbclid: 'fb.1' },
    });
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
    fireEvent.input(screen.getByLabelText(/^E-mail/), { target: { value: 'pessoa@example.com' } });
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
    fireEvent.input(screen.getByLabelText(/^E-mail/), { target: { value: 'pessoa@example.com' } });
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

  it('says so for a page that does not take the form, and blocks sending while Turnstile is unset', async () => {
    renderAt('/lp/nao-existe');
    expect(await screen.findByText('Página não encontrada')).toBeTruthy();
    cleanup();
    get.mockImplementation(async () => ({
      slug: 'cenoritas',
      brand: 'Cenoritas',
      turnstileSiteKey: null,
      instagram: null,
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
