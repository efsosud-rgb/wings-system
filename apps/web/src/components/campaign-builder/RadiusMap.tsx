import {
  DEFAULT_RADIUS_KM,
  MAX_CUSTOM_LOCATIONS,
  MAX_RADIUS_KM,
  MIN_RADIUS_KM,
  RADIUS_NOT_ACCEPTED_HINT,
  describeCustomLocation,
  type CustomLocation,
} from '@wings/shared';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';

/**
 * Reach by radius: click a point, drag the radius.
 *
 * Leaflet over OpenStreetMap tiles — no key, no cost. Plain Leaflet rather
 * than a React wrapper: the map is one imperative widget, and what React owns
 * is only the list of locations. Points are drawn as vector circles, so no
 * marker image has to survive the bundler.
 *
 * Two things leave the browser, both to OpenStreetMap and neither carrying
 * anything about the campaign: the tiles for the area on screen, and one
 * lookup of the clicked coordinates to give the point a name a person can
 * read. If that lookup fails the point simply stays "Ponto N".
 */

const BRAZIL_CENTER: L.LatLngTuple = [-14.2, -51.9];
const ACCENT = '#e95228';

/** A place name for the clicked point; null when the lookup does not answer. */
async function nameOf(latitude: number, longitude: number): Promise<string | null> {
  try {
    const response = await fetch(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=pt-BR&lat=${latitude}&lon=${longitude}`,
      { signal: AbortSignal.timeout(6_000) },
    );
    if (!response.ok) return null;
    const body = (await response.json()) as {
      address?: {
        city?: string;
        town?: string;
        village?: string;
        municipality?: string;
        state?: string;
      };
    };
    const place =
      body.address?.city ??
      body.address?.town ??
      body.address?.village ??
      body.address?.municipality;
    if (!place) return null;
    return (body.address?.state ? `${place}, ${body.address.state}` : place).slice(0, 80);
  } catch {
    return null;
  }
}

export interface RadiusMapProps {
  value: CustomLocation[];
  onChange: (next: CustomLocation[]) => void;
  /**
   * The platform takes no radius. The map stays on screen — the block looks
   * the same on every platform — but marks nothing, and says what to use.
   */
  disabled?: boolean;
}

export function RadiusMap({ value, onChange, disabled = false }: RadiusMapProps) {
  const container = useRef<HTMLDivElement | null>(null);
  const map = useRef<L.Map | null>(null);
  const shapes = useRef<L.LayerGroup | null>(null);
  const [selected, setSelected] = useState(0);

  // The click handler lives as long as the map; these let it see today's props.
  const latest = useRef({ value, onChange, disabled });
  latest.current = { value, onChange, disabled };

  useEffect(() => {
    if (!container.current || map.current) return;
    const instance = L.map(container.current, { scrollWheelZoom: false }).setView(BRAZIL_CENTER, 4);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 18,
      attribution:
        '&copy; colaboradores do <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(instance);
    shapes.current = L.layerGroup().addTo(instance);
    map.current = instance;

    instance.on('click', (event: L.LeafletMouseEvent) => {
      const { value: current, onChange: emit, disabled: off } = latest.current;
      if (off || current.length >= MAX_CUSTOM_LOCATIONS) return;
      const latitude = Number(event.latlng.lat.toFixed(5));
      const longitude = Number(event.latlng.lng.toFixed(5));
      const index = current.length;
      emit([...current, { latitude, longitude, radiusKm: DEFAULT_RADIUS_KM }]);
      setSelected(index);

      void nameOf(latitude, longitude).then((label) => {
        if (!label) return;
        const now = latest.current.value;
        // Only if that very point is still there: it may have been removed.
        if (now[index]?.latitude !== latitude || now[index]?.longitude !== longitude) return;
        latest.current.onChange(now.map((item, i) => (i === index ? { ...item, label } : item)));
      });
    });

    return () => {
      instance.remove();
      map.current = null;
      shapes.current = null;
    };
  }, []);

  // Redraw the circles whenever the locations change.
  useEffect(() => {
    const group = shapes.current;
    if (!group) return;
    group.clearLayers();
    value.forEach((location, index) => {
      const centre: L.LatLngTuple = [location.latitude, location.longitude];
      const active = index === selected;
      L.circle(centre, {
        radius: location.radiusKm * 1000,
        color: ACCENT,
        weight: active ? 2 : 1,
        fillOpacity: active ? 0.22 : 0.1,
      })
        .on('click', (event) => {
          L.DomEvent.stopPropagation(event);
          setSelected(index);
        })
        .addTo(group);
      L.circleMarker(centre, {
        radius: 5,
        color: '#fff',
        weight: 2,
        fillColor: ACCENT,
        fillOpacity: 1,
      }).addTo(group);
    });
  }, [value, selected]);

  // Bring a newly added or newly selected point into view, radius included.
  const focus = value[selected];
  const focusKey = focus ? `${focus.latitude},${focus.longitude},${focus.radiusKm}` : '';
  useEffect(() => {
    if (!map.current || !focus) return;
    const bounds = L.latLng(focus.latitude, focus.longitude).toBounds(focus.radiusKm * 2000);
    map.current.fitBounds(bounds, { padding: [24, 24], maxZoom: 12 });
    // Keyed on the point's own values, not on the object: it is rebuilt every render.
  }, [focusKey]);

  const current = value[selected];
  const full = value.length >= MAX_CUSTOM_LOCATIONS;

  return (
    <div className={`radius-map ${disabled ? 'is-disabled' : ''}`} aria-disabled={disabled}>
      <span className="field-label">Raio no mapa</span>
      <p className="field-hint" role={disabled ? 'note' : undefined}>
        {disabled
          ? `${RADIUS_NOT_ACCEPTED_HINT}.`
          : full
            ? `Limite de ${MAX_CUSTOM_LOCATIONS} pontos. Remova um para marcar outro.`
            : 'Clique no mapa para marcar o centro. Depois ajuste o raio. Use os botões + e − para aproximar.'}
      </p>
      <div
        ref={container}
        className="radius-map-canvas"
        role="application"
        aria-label="Mapa para marcar um ponto e um raio de alcance"
      />

      {current && !disabled && (
        <label className="radius-map-slider">
          <span>
            Raio: <strong>{current.radiusKm} km</strong>
            <small className="muted">
              {' '}
              — de {MIN_RADIUS_KM} a {MAX_RADIUS_KM} km
            </small>
          </span>
          <input
            type="range"
            min={MIN_RADIUS_KM}
            max={MAX_RADIUS_KM}
            step={1}
            value={current.radiusKm}
            aria-label="Raio em quilômetros"
            onChange={(event) =>
              onChange(
                value.map((item, index) =>
                  index === selected ? { ...item, radiusKm: Number(event.target.value) } : item,
                ),
              )
            }
          />
        </label>
      )}

      {value.length > 0 && !disabled && (
        <ul className="builder-cities radius-map-list">
          {value.map((location, index) => (
            <li key={`${location.latitude},${location.longitude}`}>
              <button
                type="button"
                className={`link-button ${index === selected ? 'is-selected' : ''}`}
                aria-pressed={index === selected}
                onClick={() => setSelected(index)}
              >
                {describeCustomLocation(location, index)}
              </button>
              <button
                type="button"
                className="link-button"
                aria-label={`Remover ponto ${index + 1}`}
                onClick={() => {
                  onChange(value.filter((_, i) => i !== index));
                  setSelected(0);
                }}
              >
                Remover
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
