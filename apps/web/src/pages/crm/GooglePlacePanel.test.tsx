import type { ProspectPlaceResponse } from '@wings/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';

const get = vi.fn();
vi.mock('../../api/client.js', async (original) => ({
  ...(await original<typeof import('../../api/client.js')>()),
  api: { get: (path: string) => get(path) },
}));

const { GooglePlacePanel } = await import('./GooglePlacePanel.js');

const usage = {
  today: { used: 1, limit: 40 },
  month: { searches: 0, searchLimit: 950, details: 1, detailsLimit: 950 },
};
// A made-up place: no real company.
const found: ProspectPlaceResponse = {
  found: true,
  usage,
  place: {
    placeId: 'ChIJ_fake_place_0001',
    name: 'Hamburgueria Exemplo',
    address: 'Rua Fictícia, 100 - Icaraí, Niterói - RJ',
    phone: '(21) 90000-0001',
    website: 'https://exemplo.invalid/',
    rating: 4.6,
    reviews: 320,
    businessStatus: 'OPERATIONAL',
    mapsUri: 'https://maps.google.com/?cid=1',
    types: [],
  },
};

beforeEach(() => get.mockReset());
afterEach(cleanup);

const show = () =>
  render(
    <QueryClientProvider client={new QueryClient()}>
      <GooglePlacePanel leadId="l1" />
    </QueryClientProvider>,
  );

describe('Dados do Google (ao vivo)', () => {
  it('calls Google only on the click, and shows the place with the Maps link and attribution', async () => {
    get.mockResolvedValue(found);
    show();
    expect(get).not.toHaveBeenCalled();
    expect(screen.getByText(/gasta 1 ficha da cota do mês/)).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Carregar do Google' }));
    expect(await screen.findByText('Hamburgueria Exemplo')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/prospecting/leads/l1/place');
    expect(screen.getByText('4,6')).toBeTruthy();
    expect(screen.getByText('Em funcionamento')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir no Google Maps' }).getAttribute('href')).toBe(
      'https://maps.google.com/?cid=1',
    );
    expect(screen.getByText(/Dados: Google Maps/)).toBeTruthy();
  });

  it('says "—" and the reason without the key, and when Google no longer has the place', async () => {
    get.mockRejectedValueOnce(
      new ApiError(503, {
        error: 'places_not_configured',
        message: 'Chave do Google não configurada.',
      }),
    );
    show();
    fireEvent.click(screen.getByRole('button', { name: 'Carregar do Google' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      '— Chave do Google não configurada.',
    );

    get.mockResolvedValueOnce({ found: false, message: 'Não encontrado no Google.', usage });
    fireEvent.click(screen.getByRole('button', { name: 'Carregar do Google' }));
    expect(await screen.findByText('— Não encontrado no Google.')).toBeTruthy();
  });
});
