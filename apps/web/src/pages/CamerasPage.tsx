import {
  CAMERA_ALERT_KIND_LABELS,
  CAMERA_AREA_KIND_LABELS,
  CAMERA_AREA_KINDS,
  CAMERA_DEVICE_KIND_LABELS,
  CAMERA_DEVICE_KINDS,
  CAMERA_UNIT_KIND_LABELS,
  CAMERA_UNIT_KINDS,
  SALES_PERIOD_LABELS,
  SALES_PERIODS,
  type CameraAreaKind,
  type CameraDeviceCreated,
  type CameraDeviceKind,
  type CamerasDashboard,
  type CameraUnitKind,
  type SalesPeriod,
} from '@wings/shared';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { ApiError } from '../api/client.js';
import {
  useCamerasDashboard,
  useCreateCameraDevice,
  useRevokeCameraDevice,
} from '../api/cameras.js';
import { DASH, formatDateTime, formatInt } from '../components/dashboard/format.js';
import { LoadFailure } from '../components/LoadFailure.js';
import { PageHeader } from '../components/PageHeader.js';
import { Button, Input, Select } from '../components/ui.js';
import { CopyButton } from './crm/CopyButton.js';

/**
 * Gestão → Câmeras (docs/cameras.md): people flow per area as numbers only.
 * The video stays on site; nothing here shows an image or a person. A number
 * the devices have not given yet shows "—" with the reason, never a zero.
 */

const WEEKDAYS = ['Segunda', 'Terça', 'Quarta', 'Quinta', 'Sexta', 'Sábado', 'Domingo'];
const hourLabel = (hour: number) => `${String(hour).padStart(2, '0')}h`;
/** The `<option>`s of a list of codes, each with its label. */
const optionsOf = <T extends string>(values: readonly T[], labels: Record<T, string>) =>
  values.map((value) => (
    <option key={value} value={value}>
      {labels[value]}
    </option>
  ));
const isIn = <T extends string>(list: readonly T[], value: string | null): value is T =>
  value !== null && (list as readonly string[]).includes(value);

function Gap({ reason }: { reason: string }) {
  return (
    <span className="muted" title={reason} aria-label={`sem dado: ${reason}`}>
      {DASH}
    </span>
  );
}

/** A count with a bar beside it, as a share of the biggest value of its list. */
function Bar({ value, max }: { value: number; max: number }) {
  const width = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <span className="cam-bar" aria-hidden="true">
      <span className="cam-bar-fill" style={{ width: `${width}%` }} />
    </span>
  );
}

function DeviceForm({ units }: { units: CamerasDashboard['units'] }) {
  const create = useCreateCameraDevice();
  const [made, setMade] = useState<CameraDeviceCreated | null>(null);
  const [unitId, setUnitId] = useState(units[0]?.id ?? '');
  const [unitKind, setUnitKind] = useState<CameraUnitKind>('escritorio');
  const [areaKind, setAreaKind] = useState<CameraAreaKind>('porta');
  const [kind, setKind] = useState<CameraDeviceKind>('camera');

  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const text = (name: string) => String(form.get(name) ?? '').trim();
    create.mutate(
      {
        ...(unitId ? { unitId } : { unitName: text('unitName'), unitKind }),
        areaCode: text('areaCode'),
        areaName: text('areaName'),
        areaKind,
        ...(text('capacity') ? { capacity: Number(text('capacity')) } : {}),
        name: text('name'),
        kind,
        test: form.get('test') === 'on',
      },
      { onSuccess: (answer) => setMade(answer) },
    );
  };

  if (made)
    return (
      <div className="card" role="status">
        <h3>Dispositivo cadastrado: {made.device.name}</h3>
        <p>
          Copie o token agora e guarde no dispositivo. Ele <strong>não é mostrado de novo</strong>:
          o sistema guarda só a assinatura dele.
        </p>
        <p>
          <code>{made.token}</code> <CopyButton value={made.token} label="Copiar token" />
        </p>
        <Button type="button" onClick={() => setMade(null)}>
          Cadastrar outro
        </Button>
      </div>
    );

  return (
    <form className="card cam-form" onSubmit={submit} aria-label="Cadastrar dispositivo">
      <h3>Cadastrar dispositivo</h3>
      <p className="muted">
        Só o Admin Master cadastra. O dispositivo manda contagens a cada 15 minutos com o token
        próprio; nenhuma imagem é aceita.
      </p>
      <div className="form-grid">
        <label>
          Unidade
          <Select value={unitId} onChange={(event) => setUnitId(event.target.value)}>
            {units.map((unit) => (
              <option key={unit.id} value={unit.id}>
                {unit.name}
              </option>
            ))}
            <option value="">Nova unidade…</option>
          </Select>
        </label>
        {!unitId && (
          <>
            <label>
              Nome da unidade
              <Input name="unitName" required minLength={2} maxLength={80} />
            </label>
            <label>
              Tipo da unidade
              <Select
                value={unitKind}
                onChange={(event) => setUnitKind(event.target.value as CameraUnitKind)}
              >
                {optionsOf(CAMERA_UNIT_KINDS, CAMERA_UNIT_KIND_LABELS)}
              </Select>
            </label>
          </>
        )}
        <label>
          Código da área
          <Input
            name="areaCode"
            required
            pattern="[a-z0-9-]{1,40}"
            placeholder="porta, recepcao, sala-1"
          />
        </label>
        <label>
          Nome da área
          <Input name="areaName" required minLength={2} maxLength={80} />
        </label>
        <label>
          Tipo da área
          <Select
            value={areaKind}
            onChange={(event) => setAreaKind(event.target.value as CameraAreaKind)}
          >
            {optionsOf(CAMERA_AREA_KINDS, CAMERA_AREA_KIND_LABELS)}
          </Select>
        </label>
        <label>
          Lugares (salas)
          <Input name="capacity" type="number" min={1} max={500} />
        </label>
        <label>
          Nome do dispositivo
          <Input name="name" required minLength={2} maxLength={80} />
        </label>
        <label>
          Tipo do dispositivo
          <Select
            value={kind}
            onChange={(event) => setKind(event.target.value as CameraDeviceKind)}
          >
            {optionsOf(CAMERA_DEVICE_KINDS, CAMERA_DEVICE_KIND_LABELS)}
          </Select>
        </label>
        <label className="cam-check">
          <input type="checkbox" name="test" /> Dispositivo de teste (fica fora do painel)
        </label>
      </div>
      {create.isError && (
        <p className="form-error" role="alert">
          {create.error instanceof ApiError ? create.error.message : 'Não foi possível cadastrar.'}
        </p>
      )}
      <Button type="submit" disabled={create.isPending}>
        Cadastrar e gerar token
      </Button>
    </form>
  );
}

export function CamerasPage() {
  const [params, setParams] = useSearchParams();
  const periodParam = params.get('periodo');
  const period: SalesPeriod = isIn(SALES_PERIODS, periodParam) ? periodParam : '30d';
  const from = params.get('de') ?? '';
  const to = params.get('ate') ?? '';
  const unit = params.get('unidade') ?? '';
  const set = (patch: Record<string, string>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(patch)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    setParams(next, { replace: true });
  };
  const custom = period === 'custom' && from && to;
  const query: Record<string, string> = { period: period === 'custom' && !custom ? '30d' : period };
  if (custom) Object.assign(query, { from, to });
  if (unit) query.unit = unit;
  const result = useCamerasDashboard(query);
  const revoke = useRevokeCameraDevice();
  const data = result.data;
  const maxHour = Math.max(0, ...(data?.byHour.map((h) => h.entries ?? 0) ?? [0]));
  const maxDay = Math.max(0, ...(data?.byWeekday.map((d) => d.entries ?? 0) ?? [0]));

  return (
    <>
      <PageHeader
        title="Câmeras"
        subtitle="Fluxo de pessoas por área, em números. O vídeo fica no local: nenhuma imagem, rosto ou identificação chega aqui."
      >
        <div className="filters-row" role="group" aria-label="Filtros das câmeras">
          <label>
            <span className="sr-only">Unidade</span>
            <Select value={unit} onChange={(event) => set({ unidade: event.target.value })}>
              <option value="">Todas as unidades</option>
              {data?.units.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </Select>
          </label>
          <label>
            <span className="sr-only">Período</span>
            <Select
              value={period}
              onChange={(event) =>
                set({ periodo: event.target.value === '30d' ? '' : event.target.value })
              }
            >
              {optionsOf(SALES_PERIODS, SALES_PERIOD_LABELS)}
            </Select>
          </label>
          {period === 'custom' && (
            <>
              <label>
                <span className="sr-only">De</span>
                <Input
                  type="date"
                  value={from}
                  onChange={(event) => set({ de: event.target.value })}
                />
              </label>
              <label>
                <span className="sr-only">Até</span>
                <Input
                  type="date"
                  value={to}
                  onChange={(event) => set({ ate: event.target.value })}
                />
              </label>
            </>
          )}
        </div>
      </PageHeader>

      {result.isError && (
        <LoadFailure what="as câmeras" error={result.error} onRetry={() => void result.refetch()} />
      )}
      {!data && result.isLoading && <p className="muted">Carregando…</p>}
      {data && (
        <>
          <p className="muted">
            {data.reason ? `${DASH} ${data.reason}. ` : ''}
            {data.loadedAt
              ? `Último lote em ${formatDateTime(data.loadedAt)}.`
              : `Último lote: ${DASH} (nenhum lote recebido).`}
          </p>
          <div className="sales-grid">
            <section className="card sales-card" aria-labelledby="cam-hours">
              <h2 id="cam-hours">Entradas por hora</h2>
              <p className="sales-note">
                Pessoas que entraram pela porta, somadas por hora do dia no período.
              </p>
              <table className="cam-table">
                <tbody>
                  {data.byHour
                    .filter((h) => h.hour >= 6 && h.hour <= 22)
                    .map((h) => (
                      <tr key={h.hour}>
                        <th scope="row">{hourLabel(h.hour)}</th>
                        <td>
                          {h.entries === null ? (
                            <Gap reason={data.reason ?? 'nenhum dispositivo na porta'} />
                          ) : (
                            <>
                              <Bar value={h.entries} max={maxHour} /> {formatInt(h.entries)}
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </section>
            <section className="card sales-card" aria-labelledby="cam-weekdays">
              <h2 id="cam-weekdays">Por dia da semana</h2>
              <p className="sales-note">Entradas pela porta somadas por dia da semana.</p>
              <table className="cam-table">
                <tbody>
                  {data.byWeekday.map((d) => (
                    <tr key={d.weekday}>
                      <th scope="row">{WEEKDAYS[d.weekday - 1]}</th>
                      <td>
                        {d.entries === null ? (
                          <Gap reason={data.reason ?? 'nenhum dispositivo na porta'} />
                        ) : (
                          <>
                            <Bar value={d.entries} max={maxDay} /> {formatInt(d.entries)}
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <h3>Horários de pico</h3>
              {data.peaks.length === 0 ? (
                <p className="muted">
                  {DASH} {data.reason ?? 'nenhuma entrada contada no período'}
                </p>
              ) : (
                <ol>
                  {data.peaks.map((p) => (
                    <li key={p.hour}>
                      {hourLabel(p.hour)}: {formatInt(p.entries)} entradas
                    </li>
                  ))}
                </ol>
              )}
            </section>
            <section className="card sales-card" aria-labelledby="cam-rooms">
              <h2 id="cam-rooms">Salas de reunião</h2>
              <p className="sales-note">
                Em quantas faixas de 15 minutos havia alguém na sala, o máximo de pessoas e a
                permanência média.
              </p>
              {data.rooms.length === 0 ? (
                <p className="muted">{DASH} nenhuma sala de reunião cadastrada</p>
              ) : (
                <table className="cam-table">
                  <thead>
                    <tr>
                      <th scope="col">Sala</th>
                      <th scope="col">Ocupação</th>
                      <th scope="col">Máximo</th>
                      <th scope="col">Permanência média</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rooms.map((room) => (
                      <tr key={room.code}>
                        <th scope="row">
                          {room.name}
                          {room.capacity ? ` · ${room.capacity} lugares` : ''}
                        </th>
                        <td>
                          {room.slotsObserved > 0 ? (
                            `${Math.round((room.slotsOccupied / room.slotsObserved) * 100)}% (${room.slotsOccupied}/${room.slotsObserved})`
                          ) : (
                            <Gap reason="nenhum lote desta sala no período" />
                          )}
                        </td>
                        <td>
                          {room.maxOccupancy === null ? (
                            <Gap reason="sem contagem" />
                          ) : (
                            formatInt(room.maxOccupancy)
                          )}
                        </td>
                        <td>
                          {room.avgDwellMinutes === null ? (
                            <Gap reason="nenhuma permanência encerrada" />
                          ) : (
                            `${formatInt(Math.round(room.avgDwellMinutes))} min`
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
              <p>
                Reservas que ficaram vazias:{' '}
                {data.reservedEmpty.count === null ? (
                  <>
                    {DASH} ({data.reservedEmpty.reason})
                  </>
                ) : (
                  formatInt(data.reservedEmpty.count)
                )}
              </p>
            </section>
            <section className="card sales-card" aria-labelledby="cam-alerts">
              <h2 id="cam-alerts">Alertas</h2>
              {data.alerts.length === 0 ? (
                <p className="muted">Nenhum alerta no período.</p>
              ) : (
                <ul>
                  {data.alerts.map((alert) => (
                    <li key={alert.kind}>
                      {CAMERA_ALERT_KIND_LABELS[alert.kind]} · {formatInt(alert.count)}
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="card sales-card sales-card-wide" aria-labelledby="cam-devices">
              <h2 id="cam-devices">Dispositivos</h2>
              {data.devices.length === 0 ? (
                <p className="muted">{DASH} nenhum dispositivo cadastrado</p>
              ) : (
                <table className="cam-table">
                  <thead>
                    <tr>
                      <th scope="col">Dispositivo</th>
                      <th scope="col">Área</th>
                      <th scope="col">Tipo</th>
                      <th scope="col">Último lote</th>
                      {data.canManage && <th scope="col" />}
                    </tr>
                  </thead>
                  <tbody>
                    {data.devices.map((device) => (
                      <tr key={device.id}>
                        <th scope="row">{device.name}</th>
                        <td>{device.area}</td>
                        <td>{CAMERA_DEVICE_KIND_LABELS[device.kind]}</td>
                        <td>
                          {device.lastBatchAt ? formatDateTime(device.lastBatchAt) : DASH}
                          {device.reason ? <span className="muted"> ({device.reason})</span> : null}
                        </td>
                        {data.canManage && (
                          <td>
                            <Button
                              type="button"
                              disabled={revoke.isPending}
                              onClick={() => {
                                if (
                                  window.confirm(
                                    `Revogar o token de ${device.name}? O dispositivo para de mandar lotes.`,
                                  )
                                )
                                  revoke.mutate(device.id);
                              }}
                            >
                              Revogar token
                            </Button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>
            {data.canManage && (
              <section className="sales-card-wide" aria-label="Cadastro de dispositivo">
                <DeviceForm units={data.units} />
              </section>
            )}
          </div>
        </>
      )}
    </>
  );
}
