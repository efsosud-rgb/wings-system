import type { OfficeSnapshot } from '@wings/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { OfficeFloor } from './OfficeFloor.js';
import { floorPlan } from './layout.js';

const snapshot: OfficeSnapshot = {
  generatedAt: '2026-10-06T15:00:00.000Z',
  hour: 12,
  minute: 0,
  people: [
    {
      id: 'p1',
      displayName: 'Ana',
      sector: 'comercial',
      zone: 'comercial',
      roleName: 'Vendedor Formatação',
      isSectorManager: false,
      present: true,
      lastSeenAt: '2026-10-06T14:58:00.000Z',
      openDeals: 1,
      openTasks: 1,
      overdueTasks: 1,
      monitor: {
        kind: 'task',
        taskId: 't1',
        leadId: 'l1',
        taskKind: 'call',
        dueAt: '2026-10-06T14:00:00.000Z',
        overdue: true,
        pipeline: 'formatacao',
        stage: 'Sem contato',
      },
    },
    {
      id: 'p2',
      displayName: 'Beto',
      sector: 'formatacao',
      zone: 'formatacao-processos-projetos',
      roleName: 'Formatação — Processos e Projetos',
      isSectorManager: false,
      present: false,
      lastSeenAt: null,
      openDeals: 0,
      openTasks: 0,
      overdueTasks: 0,
      monitor: { kind: 'none', reason: 'Sem tarefa aberta nem negociação em andamento no CRM' },
    },
  ],
  agents: [
    {
      key: 'sofia',
      name: 'Sofia (SDR)',
      zone: 'comercial',
      lastActivityAt: null,
      lastActivity: null,
      reason: 'Nenhuma ação da Sofia registrada no CRM do Wings ainda',
      openProposals: null,
    },
  ],
  events: [
    {
      id: 'move:1',
      kind: 'deal_won',
      at: '2026-10-06T14:40:00.000Z',
      employeeId: 'p1',
      leadId: 'l1',
      taskId: null,
      pipeline: 'formatacao',
      detail: 'Ganho',
    },
  ],
  kpis: [
    { key: 'leads_today', label: 'Leads novos hoje', value: 3, reason: null },
    { key: 'won_today', label: 'Vendas ganhas hoje', value: null, reason: 'Sem resposta do banco' },
  ],
};

describe('floorPlan', () => {
  it('gives every person and agent a desk inside their room, in metres', () => {
    const plan = floorPlan(snapshot);
    expect(plan.desks.map((d) => d.id)).toEqual(['p1', 'agent:sofia', 'p2']);
    for (const desk of plan.desks) {
      const room = plan.rooms.find((r) => r.key === desk.zone)!;
      expect(desk.x).toBeGreaterThan(room.x);
      expect(desk.x).toBeLessThan(room.x + room.w);
      expect(desk.z).toBeGreaterThan(room.z);
      expect(desk.z).toBeLessThan(room.z + room.d);
    }
    expect(plan.rooms.map((r) => r.key)).toContain('lounge');
    expect(plan.props.some((p) => p.name === 'cat')).toBe(true);
  });

  it('never overlaps two rooms', () => {
    const { rooms } = floorPlan(snapshot);
    for (const a of rooms) {
      for (const b of rooms) {
        if (a === b) continue;
        const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.z + a.d <= b.z || b.z + b.d <= a.z;
        expect(apart).toBe(true);
      }
    }
  });
});

describe('OfficeFloor without WebGL', () => {
  it('shows the same office as a list, with "—" and the reason where data is missing', () => {
    render(
      <MemoryRouter>
        <OfficeFloor snapshot={snapshot} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Sem WebGL neste navegador/)).toBeTruthy();
    expect(screen.getByText('Leads novos hoje').parentElement?.textContent).toContain('3');
    expect(screen.getByText('Vendas ganhas hoje').parentElement?.textContent).toContain('—');
    expect(screen.getByText('Sem resposta do banco')).toBeTruthy();

    const list = document.querySelector('.o3d-list') as HTMLElement;
    expect(within(list).getByText('Ligação · atrasada')).toBeTruthy();
    expect(within(list).getByText(/— Sem tarefa aberta nem negociação/)).toBeTruthy();
    expect(within(list).getByText(/— Nenhuma ação da Sofia/)).toBeTruthy();
    expect(within(list).getByRole('link', { name: 'Negociação' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1',
    );

    const feed = document.querySelector('.o3d-feed') as HTMLElement;
    expect(within(feed).getByText(/Venda ganha · Formatação/)).toBeTruthy();
    expect(within(feed).getByRole('link', { name: 'Abrir' }).getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1',
    );
  });
});
