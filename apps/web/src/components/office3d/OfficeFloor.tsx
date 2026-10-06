import {
  LEAD_PIPELINE_LABELS,
  OFFICE_LIGHT_LABELS,
  OFFICE_TIME_ZONE,
  OFFICE_ZONES,
  officeEventText,
  officeLightAt,
  officeLinkOf,
  officeMonitorText,
  officeZoneLabel,
  type OfficeAgent,
  type OfficeEvent,
  type OfficePerson,
  type OfficeSnapshot,
} from '@wings/shared';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import './office3d.css';

type EngineModule = typeof import('./engine.js');
type Engine = import('./engine.js').OfficeEngine;

let loading: Promise<EngineModule | null> | null = null;
const loadEngine = () => (loading ??= import('./engine.js').catch(() => null));

/** WebGL2 and a real browser; jsdom and old browsers get the list. */
const canUse3d = () =>
  typeof window !== 'undefined' &&
  typeof WebGL2RenderingContext !== 'undefined' &&
  typeof requestAnimationFrame === 'function' &&
  typeof ResizeObserver !== 'undefined';

const TIME = new Intl.DateTimeFormat('pt-BR', {
  timeZone: OFFICE_TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
});
const DAY = new Intl.DateTimeFormat('pt-BR', {
  timeZone: OFFICE_TIME_ZONE,
  day: '2-digit',
  month: '2-digit',
});

function when(iso: string | null, now: string): string {
  if (!iso) return '—';
  const at = new Date(iso);
  const sameDay = DAY.format(at) === DAY.format(new Date(now));
  return sameDay ? TIME.format(at) : `${DAY.format(at)} ${TIME.format(at)}`;
}

/** Wins already celebrated in this tab, so a reload does not throw the confetti again. */
const CELEBRATED_KEY = 'wings.office.celebrated';
function celebrated(): Set<string> {
  try {
    return new Set(JSON.parse(sessionStorage.getItem(CELEBRATED_KEY) ?? '[]') as string[]);
  } catch {
    return new Set();
  }
}
function remember(ids: Set<string>) {
  try {
    sessionStorage.setItem(CELEBRATED_KEY, JSON.stringify([...ids].slice(-100)));
  } catch {
    // Private mode or blocked storage: the confetti may repeat, nothing else changes.
  }
}

/** A win counts as news on the first load only within this window. */
const FRESH_WIN_MS = 2 * 3600_000;

export function OfficeFloor({ snapshot }: { snapshot: OfficeSnapshot }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const labelsRef = useRef<HTMLDivElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const seenRef = useRef<Set<string> | null>(null);
  const snapshotRef = useRef(snapshot);
  snapshotRef.current = snapshot;
  const [mode, setMode] = useState<'loading' | '3d' | 'list'>(() =>
    canUse3d() ? 'loading' : 'list',
  );
  const [asList, setAsList] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  useEffect(() => {
    if (mode === 'list') return;
    let cancelled = false;
    let cleanup = () => {};
    void loadEngine().then((module) => {
      const stage = stageRef.current;
      const canvas = canvasRef.current;
      const labels = labelsRef.current;
      if (cancelled) return;
      const engine =
        module && stage && canvas && labels
          ? module.createOfficeEngine({ stage, canvas, labels }, { onSelect: setSelected })
          : null;
      if (!engine || !stage) {
        setMode('list');
        return;
      }
      engineRef.current = engine;
      engine.resize();
      engine.setSnapshot(snapshotRef.current);
      const observer = new ResizeObserver(() => engine.resize());
      observer.observe(stage);
      setMode('3d');
      // Development only: lets the screenshot/FPS check read the engine's numbers.
      if (import.meta.env.DEV) (window as unknown as { __office?: Engine }).__office = engine;
      cleanup = () => {
        observer.disconnect();
        engine.dispose();
        engineRef.current = null;
        if (import.meta.env.DEV) delete (window as unknown as { __office?: Engine }).__office;
      };
    });
    return () => {
      cancelled = true;
      cleanup();
    };
    // The engine is made once; data changes go through setSnapshot below.
  }, []);

  // New data: repaint, and let people react to what they really did since the last read.
  useEffect(() => {
    // Until the engine is up, events wait: a win must not be marked as celebrated unseen.
    if (mode === 'loading') return;
    const engine = engineRef.current;
    if (engine) engine.setSnapshot(snapshot);
    const now = Date.parse(snapshot.generatedAt);
    const done = celebrated();
    let fresh: OfficeEvent[];
    if (!seenRef.current) {
      fresh = snapshot.events.filter(
        (e) => e.kind === 'deal_won' && !done.has(e.id) && now - Date.parse(e.at) < FRESH_WIN_MS,
      );
      seenRef.current = new Set(snapshot.events.map((e) => e.id));
    } else {
      const seen = seenRef.current;
      fresh = snapshot.events.filter((e) => !seen.has(e.id) && !done.has(e.id));
      for (const e of snapshot.events) seen.add(e.id);
    }
    if (!engine) return;
    if (fresh.length) engine.react(fresh);
    const wins = fresh.filter((e) => e.kind === 'deal_won');
    if (wins.length) {
      for (const win of wins) done.add(win.id);
      remember(done);
    }
  }, [snapshot, mode]);

  const people = useMemo(() => new Map(snapshot.people.map((p) => [p.id, p])), [snapshot.people]);
  const agents = useMemo(
    () => new Map(snapshot.agents.map((a) => [`agent:${a.key}`, a])),
    [snapshot.agents],
  );
  const light = officeLightAt(snapshot.hour, snapshot.minute);
  const pick = (id: string | null) => {
    setSelected(id);
    engineRef.current?.select(id, false);
  };

  const person = selected ? people.get(selected) : undefined;
  const agent = selected ? agents.get(selected) : undefined;
  const showList = mode === 'list' || asList;

  return (
    <div className="o3d">
      <div className="o3d-body">
        <div className="o3d-main">
          <div className="o3d-world" data-light={light}>
            <div className="o3d-kpis" role="list" aria-label="Indicadores de hoje">
              {snapshot.kpis.map((kpi) => (
                <div key={kpi.key} className="o3d-kpi" role="listitem">
                  <span className="o3d-kpi__label">{kpi.label}</span>
                  <strong className="o3d-kpi__value">{kpi.value ?? '—'}</strong>
                  {kpi.reason ? <span className="o3d-kpi__reason">{kpi.reason}</span> : null}
                </div>
              ))}
            </div>

            {mode !== 'list' ? (
              <div ref={stageRef} className="o3d-stage" data-light={light} hidden={asList}>
                <canvas
                  ref={canvasRef}
                  className="o3d-canvas"
                  tabIndex={0}
                  role="img"
                  aria-label={`Escritório em 3D com ${snapshot.people.length} pessoas e ${snapshot.agents.length} agentes. Setas escolhem uma mesa; Esc volta à visão geral. A mesma informação está em "Ver como lista".`}
                />
                <div ref={labelsRef} className="o3d-labels" aria-hidden="true" />
                {mode === 'loading' ? (
                  <div className="o3d-loading">Montando o escritório…</div>
                ) : null}
                <div className="o3d-controls">
                  <button type="button" onClick={() => pick(null)}>
                    Visão geral
                  </button>
                  <button
                    type="button"
                    aria-label="Aproximar"
                    onClick={() => engineRef.current?.zoomBy(1.25)}
                  >
                    +
                  </button>
                  <button
                    type="button"
                    aria-label="Afastar"
                    onClick={() => engineRef.current?.zoomBy(0.8)}
                  >
                    −
                  </button>
                </div>
                <div className="o3d-legend" aria-hidden="true">
                  <span>
                    <i className="o3d-dot is-task" />
                    Tarefa
                  </span>
                  <span>
                    <i className="o3d-dot is-overdue" />
                    Atrasada
                  </span>
                  <span>
                    <i className="o3d-dot is-deal" />
                    Negociação
                  </span>
                  <span>
                    <i className="o3d-dot is-agent" />
                    Agente
                  </span>
                  <span>
                    <i className="o3d-dot is-idle" />
                    Sem item
                  </span>
                </div>
              </div>
            ) : null}
          </div>

          <div className="o3d-bar">
            <span>
              Luz: {OFFICE_LIGHT_LABELS[light]} ({String(snapshot.hour).padStart(2, '0')}:
              {String(snapshot.minute).padStart(2, '0')} no Rio) · Clima: — (o sistema não tem fonte
              de clima)
            </span>
            {mode !== 'list' ? (
              <button type="button" className="o3d-link" onClick={() => setAsList((v) => !v)}>
                {asList ? 'Ver em 3D' : 'Ver como lista'}
              </button>
            ) : (
              <span>Sem WebGL neste navegador: a lista mostra o mesmo.</span>
            )}
          </div>

          {showList ? <OfficeList snapshot={snapshot} selected={selected} onPick={pick} /> : null}
        </div>

        <aside className="o3d-side">
          {person || agent ? (
            <section className="o3d-card" aria-live="polite">
              <header className="o3d-card__head">
                <h2>{person?.displayName ?? agent?.name}</h2>
                <button type="button" className="o3d-link" onClick={() => pick(null)}>
                  Fechar
                </button>
              </header>
              {person ? <PersonCard person={person} snapshot={snapshot} /> : null}
              {agent ? <AgentCard agent={agent} snapshot={snapshot} /> : null}
            </section>
          ) : null}

          <section className="o3d-card o3d-feed">
            <h2>Registro de atividades</h2>
            {snapshot.events.length === 0 ? (
              <p className="o3d-muted">— Nenhum evento no CRM nos últimos 7 dias.</p>
            ) : (
              <ol>
                {snapshot.events.map((event) => {
                  const who = event.employeeId ? people.get(event.employeeId)?.displayName : null;
                  return (
                    <li key={event.id} className={`o3d-event is-${event.kind}`}>
                      <time dateTime={event.at}>{when(event.at, snapshot.generatedAt)}</time>
                      <span className="o3d-event__text">
                        {officeEventText(event)}
                        {who ? (
                          <button
                            type="button"
                            className="o3d-link"
                            onClick={() => pick(event.employeeId)}
                          >
                            {who}
                          </button>
                        ) : (
                          <span className="o3d-muted"> · sem dono</span>
                        )}
                      </span>
                      <Link className="o3d-open" to={officeLinkOf(event.leadId)}>
                        Abrir
                      </Link>
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </aside>
      </div>
    </div>
  );
}

function PersonCard({ person, snapshot }: { person: OfficePerson; snapshot: OfficeSnapshot }) {
  const monitor = person.monitor;
  const recent = snapshot.events.filter((e) => e.employeeId === person.id).slice(0, 5);
  return (
    <>
      <p className="o3d-muted">
        {officeZoneLabel(person.zone)} · {person.roleName}
        {person.isSectorManager ? ' · gerente do setor' : ''}
      </p>
      <p>
        {person.present
          ? 'No sistema agora'
          : person.lastSeenAt
            ? `Fora do sistema · visto ${when(person.lastSeenAt, snapshot.generatedAt)}`
            : 'Fora do sistema · — (nunca entrou)'}
      </p>
      <dl className="o3d-facts">
        <div>
          <dt>Negociações abertas</dt>
          <dd>{person.openDeals}</dd>
        </div>
        <div>
          <dt>Tarefas abertas</dt>
          <dd>{person.openTasks}</dd>
        </div>
        <div>
          <dt>Atrasadas</dt>
          <dd>{person.overdueTasks}</dd>
        </div>
      </dl>
      <h3>No monitor</h3>
      {monitor.kind === 'none' ? (
        <p className="o3d-muted">— {monitor.reason}</p>
      ) : (
        <p>
          {monitor.kind === 'task' ? 'Tarefa: ' : 'Negociação em '}
          <strong>{officeMonitorText(monitor)}</strong>
          {monitor.kind === 'task' ? ` · prazo ${when(monitor.dueAt, snapshot.generatedAt)}` : null}
          {monitor.pipeline ? ` · ${LEAD_PIPELINE_LABELS[monitor.pipeline]}` : ''}
          {monitor.kind === 'task' && monitor.stage ? ` · etapa ${monitor.stage}` : ''}
          <br />
          <Link to={officeLinkOf(monitor.leadId)}>
            {monitor.kind === 'task' ? 'Abrir a negociação desta tarefa' : 'Abrir a negociação'}
          </Link>
        </p>
      )}
      <h3>Últimos eventos</h3>
      {recent.length ? (
        <ul className="o3d-mini">
          {recent.map((e) => (
            <li key={e.id}>
              {when(e.at, snapshot.generatedAt)} · {officeEventText(e)}
            </li>
          ))}
        </ul>
      ) : (
        <p className="o3d-muted">— Nenhum evento desta pessoa nos últimos 7 dias.</p>
      )}
    </>
  );
}

function AgentCard({ agent, snapshot }: { agent: OfficeAgent; snapshot: OfficeSnapshot }) {
  return (
    <>
      <p className="o3d-muted">Agente de IA · {officeZoneLabel(agent.zone)}</p>
      <p>
        {agent.lastActivity ? (
          <>
            {agent.lastActivity} · {when(agent.lastActivityAt, snapshot.generatedAt)}
          </>
        ) : (
          <span className="o3d-muted">— {agent.reason}</span>
        )}
      </p>
      {agent.openProposals !== null ? (
        <p>Propostas esperando uma pessoa: {agent.openProposals}</p>
      ) : null}
      <p className="o3d-muted">O agente lê e propõe; quem decide e executa é uma pessoa.</p>
    </>
  );
}

function OfficeList({
  snapshot,
  selected,
  onPick,
}: {
  snapshot: OfficeSnapshot;
  selected: string | null;
  onPick: (id: string) => void;
}) {
  return (
    <div className="o3d-list">
      {OFFICE_ZONES.map((zone) => {
        const people = snapshot.people.filter((p) => p.zone === zone);
        const agents = snapshot.agents.filter((a) => a.zone === zone);
        return (
          <section key={zone}>
            <h3>{officeZoneLabel(zone)}</h3>
            {people.length + agents.length === 0 ? (
              <p className="o3d-muted">— Ninguém ativo neste setor.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th scope="col">Quem</th>
                    <th scope="col">Agora</th>
                    <th scope="col">No monitor</th>
                    <th scope="col">Abrir</th>
                  </tr>
                </thead>
                <tbody>
                  {people.map((p) => (
                    <tr key={p.id} aria-selected={selected === p.id}>
                      <td>
                        <button type="button" className="o3d-link" onClick={() => onPick(p.id)}>
                          {p.displayName}
                        </button>
                      </td>
                      <td>{p.present ? 'No sistema' : 'Fora'}</td>
                      <td>
                        {p.monitor.kind === 'none'
                          ? `— ${p.monitor.reason}`
                          : officeMonitorText(p.monitor)}
                      </td>
                      <td>
                        {p.monitor.kind === 'none' ? (
                          '—'
                        ) : (
                          <Link to={officeLinkOf(p.monitor.leadId)}>Negociação</Link>
                        )}
                      </td>
                    </tr>
                  ))}
                  {agents.map((a) => (
                    <tr key={a.key} aria-selected={selected === `agent:${a.key}`}>
                      <td>
                        <button
                          type="button"
                          className="o3d-link"
                          onClick={() => onPick(`agent:${a.key}`)}
                        >
                          {a.name}
                        </button>
                      </td>
                      <td>Agente</td>
                      <td>{a.lastActivity ?? `— ${a.reason ?? ''}`}</td>
                      <td>—</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        );
      })}
    </div>
  );
}
