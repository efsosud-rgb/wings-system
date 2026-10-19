import type { LeadEvent } from '@wings/shared';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { LoadedLead } from '../../api/leads.js';
import { entriesOf, Timeline } from './DealTabs.js';

/**
 * The deal's timeline: a chat imported from the phone (and its undoing) appears as a WhatsApp
 * entry with the count and the days, and can be filtered on its own.
 */

afterEach(cleanup);

const event = (over: Partial<LeadEvent> & Pick<LeadEvent, 'id' | 'kind'>): LeadEvent => ({
  at: '2026-10-19T14:05:00.000Z',
  detail: {},
  ...over,
});

const loaded = (events: LeadEvent[]): LoadedLead =>
  ({
    lead: {},
    events,
    notes: [],
    tasks: [],
    history: [],
    activities: [],
  }) as unknown as LoadedLead;

const imported = event({
  id: 'e1',
  kind: 'whatsapp.conversation_imported',
  detail: {
    batchId: 'b1',
    messages: 12,
    from: '2026-10-01T15:00:00.000Z',
    to: '2026-10-18T15:00:00.000Z',
  },
});
const undone = event({
  id: 'e2',
  at: '2026-10-19T16:30:00.000Z',
  kind: 'whatsapp.import_undone',
  detail: { batchId: 'b1', messages: 12 },
});

describe('entriesOf — chats imported from the phone', () => {
  it('turns the import event into a WhatsApp entry with the count and the days', () => {
    const [entry] = entriesOf(loaded([imported]));

    expect(entry).toMatchObject({
      id: 'ee1',
      tone: 'whatsapp',
      icon: 'message',
      title: 'Conversa do celular importada',
      by: null,
      body: '12 mensagens, de 01/10/2026 a 18/10/2026. Estão na tela WhatsApp da negociação.',
    });
  });

  it('says one message in the singular', () => {
    const one = event({ ...imported, detail: { ...imported.detail, messages: 1 } });

    expect(entriesOf(loaded([one]))[0]?.body).toBe(
      '1 mensagem, de 01/10/2026 a 18/10/2026. Estão na tela WhatsApp da negociação.',
    );
  });

  it('turns the undo event into a WhatsApp entry saying how many left the conversation', () => {
    const [entry] = entriesOf(loaded([undone]));

    expect(entry).toMatchObject({
      id: 'ee2',
      tone: 'whatsapp',
      icon: 'message',
      title: 'Importação de conversa desfeita',
      body: '12 mensagens saíram da conversa',
    });
  });

  // Found by this test: importBody() writes "1 mensagem saíram da conversa" (DealTabs.tsx, importBody).
  it('agrees the verb for a single undone message ("saiu")', () => {
    const one = event({ ...undone, detail: { batchId: 'b1', messages: 1 } });

    expect(entriesOf(loaded([one]))[0]?.body).toBe('1 mensagem saiu da conversa');
  });

  it('has no body when the event carries no count, instead of inventing one', () => {
    const bare = event({ id: 'e3', kind: 'whatsapp.conversation_imported', detail: {} });

    expect(entriesOf(loaded([bare]))[0]).toMatchObject({ tone: 'whatsapp', body: null });
  });

  it('lists the newest first and leaves other system events on the "event" tone', () => {
    const other = event({ id: 'e4', at: '2026-10-18T10:00:00.000Z', kind: 'lead.file_added' });
    const system = event({ id: 'e5', at: '2026-10-17T10:00:00.000Z', kind: 'rd.deal_linked' });
    const entries = entriesOf(loaded([system, imported, other, undone]));

    expect(entries.map((entry) => [entry.id, entry.tone])).toEqual([
      ['ee2', 'whatsapp'],
      ['ee1', 'whatsapp'],
      ['ee4', 'file'],
      ['ee5', 'event'],
    ]);
  });
});

describe('Timeline — the WhatsApp filter', () => {
  it('shows a "WhatsApp" chip only when there is such an entry, and narrows the list to it', () => {
    const other = event({ id: 'e4', at: '2026-10-18T10:00:00.000Z', kind: 'rd.deal_linked' });
    const { unmount } = render(<Timeline data={loaded([other])} />);
    expect(screen.queryByRole('button', { name: 'WhatsApp' })).toBeNull();
    unmount();

    render(<Timeline data={loaded([imported, undone, other])} />);
    const chips = within(screen.getByRole('group', { name: 'Filtrar histórico' }));
    expect(chips.getByRole('button', { name: 'Tudo' })).toBeTruthy();
    expect(screen.getByText('Ligada ao negócio do RD CRM')).toBeTruthy();

    fireEvent.click(chips.getByRole('button', { name: 'WhatsApp' }));

    expect(screen.getByText('Conversa do celular importada')).toBeTruthy();
    expect(screen.getByText('Importação de conversa desfeita')).toBeTruthy();
    expect(screen.queryByText('Ligada ao negócio do RD CRM')).toBeNull();
  });
});
