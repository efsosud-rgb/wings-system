import { PAID_PLATFORMS, platformAcceptsRadius, type CustomLocation } from '@wings/shared';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Leaflet needs a real layout engine, so it is replaced by a stand-in that
 * keeps the one thing under test: the click handler the component registers.
 */
const handlers: Record<string, (event: unknown) => void> = {};
vi.mock('leaflet/dist/leaflet.css', () => ({}));
vi.mock('leaflet', () => {
  const layer = () => {
    const self = { addTo: () => self, on: () => self, clearLayers: () => undefined };
    return self;
  };
  const map = {
    setView: () => map,
    on: (name: string, handler: (event: unknown) => void) => {
      handlers[name] = handler;
      return map;
    },
    remove: () => undefined,
    fitBounds: () => undefined,
  };
  const L = {
    map: () => map,
    tileLayer: layer,
    layerGroup: layer,
    circle: layer,
    circleMarker: layer,
    latLng: () => ({ toBounds: () => ({}) }),
    DomEvent: { stopPropagation: () => undefined },
  };
  return { default: L };
});

const { RadiusMap } = await import('./RadiusMap.js');

const HINT = 'Esta plataforma não aceita raio: use estados e cidades.';
const click = () => handlers.click?.({ latlng: { lat: -22.9056, lng: -47.0608 } });

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the radius map, platform by platform', () => {
  it.each(PAID_PLATFORMS.map((platform) => [platform.label, platform.key] as const))(
    '%s: the map is always there, and takes a radius only where the platform does',
    (_label, key) => {
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
      const accepts = platformAcceptsRadius(key);
      const onChange = vi.fn<(next: CustomLocation[]) => void>();
      render(<RadiusMap value={[]} onChange={onChange} disabled={!accepts} />);

      expect(screen.getByRole('application', { name: /Mapa para marcar um ponto/ })).toBeTruthy();
      click();

      if (accepts) {
        expect(screen.queryByText(HINT)).toBeNull();
        expect(onChange).toHaveBeenCalledWith([
          { latitude: -22.9056, longitude: -47.0608, radiusKm: 15 },
        ]);
      } else {
        expect(screen.getByText(HINT)).toBeTruthy();
        expect(onChange).not.toHaveBeenCalled();
      }
    },
  );

  it('takes a radius only on Meta and Google Pesquisa (Demand Gen places the ad group, without radius)', () => {
    expect(PAID_PLATFORMS.filter((p) => !platformAcceptsRadius(p.key)).map((p) => p.key)).toEqual([
      'youtube',
      'tiktok',
      'linkedin',
      'x_twitter',
      'microsoft_ads',
      'kwai_ads',
      'pinterest_ads',
      'reddit_ads',
    ]);
  });

  it('disabled, it offers no slider and no list, whatever it is handed', () => {
    render(
      <RadiusMap
        disabled
        value={[{ latitude: -22.9, longitude: -47.06, radiusKm: 15, label: 'Campinas' }]}
        onChange={() => undefined}
      />,
    );
    expect(screen.queryByLabelText('Raio em quilômetros')).toBeNull();
    expect(screen.queryByText('15 km ao redor de Campinas')).toBeNull();
    expect(screen.getByText(HINT)).toBeTruthy();
  });
});
