import type { GoogleWorkspaceStatus, Lead, Meeting, MeetingSummary } from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client.js';
import type { LoadedLead } from '../../api/leads.js';

/**
 * The Reunião section on the meetings API: scheduling with a pasted link and
 * the Google 503 shown as a reason, "Iniciar" on the next meeting with a link,
 * and the summary to the franchisor approved with the exact text on screen.
 */

const { state, calls, mutation } = vi.hoisted(() => {
  const calls = {
    create: vi.fn(),
    approve: vi.fn(),
    edit: vi.fn(),
    send: vi.fn(),
    refuse: vi.fn(),
    summaryCreate: vi.fn(),
    update: vi.fn(),
    upload: vi.fn(),
  };
  const mutation = (mutate = vi.fn()) => ({ mutate, isPending: false, error: null });
  return {
    calls,
    mutation,
    state: {
      permissions: { 'leads.read': 'all', 'leads.write': 'all' } as Record<string, string>,
      meetings: [] as MeetingSummary[],
      meeting: null as Meeting | null,
      createError: null as unknown,
      openSpy: vi.fn(),
      google: {
        configured: true,
        state: 'disconnected',
        email: null,
        scopes: [],
        calendars: { mine: null, wings: null },
        wingsCalendarConfigured: true,
        lastError: null,
      } as GoogleWorkspaceStatus,
    },
  };
});

vi.mock('../../api/auth.js', () => ({
  useSession: () => ({ data: { id: 'e1', permissions: state.permissions } }),
  hasPermission: (user: { permissions: Record<string, string> } | undefined, key: string) =>
    Boolean(user?.permissions[key]),
}));

vi.mock('../../api/google.js', () => ({
  useGoogleStatus: () => ({ data: { status: state.google }, isPending: false }),
}));

vi.mock('../../api/crm.js', () => ({
  useMeetings: () => ({ data: state.meetings, isLoading: false, isError: false, error: null }),
  useMeeting: () => ({ data: state.meeting, isLoading: false, isError: false, error: null }),
  useNextStepTask: () => mutation(),
  useCreateMeeting: () => ({
    ...mutation(),
    mutate: (
      input: unknown,
      options?: { onSuccess?: () => void; onError?: (e: unknown) => void },
    ) => {
      calls.create(input);
      if (state.createError) options?.onError?.(state.createError);
      else options?.onSuccess?.();
    },
  }),
  useUpdateMeeting: () => mutation(calls.update),
  useUploadRecording: () => mutation(calls.upload),
  fetchRecordingLink: vi.fn(),
  useMeetingTranscript: () => ({ data: undefined, isLoading: false, isError: false }),
  useNameSpeakers: () => mutation(),
  useRequestAnalysis: () => mutation(),
  useSummarySend: () => ({
    create: mutation(calls.summaryCreate),
    edit: mutation(calls.edit),
    approve: mutation(calls.approve),
    refuse: mutation(calls.refuse),
    send: mutation(calls.send),
  }),
}));

const { MeetingsTab, meetingToStart } = await import('./DealMeetings.js');

const summary = (over: Partial<MeetingSummary> = {}): MeetingSummary => ({
  id: 'm1',
  leadId: 'l1',
  title: 'Reunião de diagnóstico',
  startsAt: '2099-01-10T13:00:00.000Z',
  endsAt: '2099-01-10T14:00:00.000Z',
  status: 'agendada',
  calendar: 'vendedor',
  meetUrl: 'https://meet.google.com/abc-defg-hij',
  ownerEmployeeId: 'e1',
  googleEventId: null,
  recordingState: 'nenhuma',
  transcriptState: 'nenhuma',
  analysisState: 'nenhuma',
  summarySendState: 'nenhum',
  ...over,
});

const SUMMARY_TEXT =
  'Olá, Paula. Resumo da reunião com um candidato à sua franquia:\n\nO candidato tem duas lojas e quer abrir a terceira.\n\nWings Company';

const meeting = (over: Partial<Meeting> = {}): Meeting => ({
  ...summary({ status: 'encerrada', analysisState: 'pronta', summarySendState: 'rascunho' }),
  attendees: [],
  googleHtmlLink: null,
  googleSync: null,
  recording: { state: 'guardada', fileId: 'f1', durationSeconds: 1800, sizeBytes: 50_000_000 },
  transcript: { state: 'pronta', segments: 42, error: null },
  analysis: {
    state: 'pronta',
    summary: 'O candidato tem duas lojas e quer abrir a terceira.',
    topics: ['Investimento'],
    participants: [],
    nextSteps: [],
    leadEvaluation: null,
    model: 'anthropic/claude-sonnet-5',
    costUsd: 0.2,
    analyzedAt: '2026-10-06T12:00:00.000Z',
    reason: null,
  },
  summarySend: {
    state: 'rascunho',
    channel: 'email',
    to: 'p•••@exemplo.com.br',
    text: SUMMARY_TEXT,
    approvedBy: null,
    approvedAt: null,
    sentAt: null,
    error: null,
  },
  createdAt: '2026-10-06T10:00:00.000Z',
  updatedAt: '2026-10-06T10:00:00.000Z',
  ...over,
});

const loaded = (pipeline: Lead['pipeline'] = 'expansao'): LoadedLead =>
  ({
    lead: {
      id: 'l1',
      pipeline,
      name: 'Candidato Exemplo',
      email: 'candidato@exemplo.com.br',
      brand: pipeline === 'expansao' ? 'Marca Exemplo' : null,
      fields: { instagram: null, website: null, companyName: 'Padaria Exemplo', cnpj: null },
    } as Lead,
    events: [],
    notes: [],
    tasks: [],
    history: [],
    activities: [],
  }) as LoadedLead;

afterEach(() => {
  cleanup();
  state.permissions = { 'leads.read': 'all', 'leads.write': 'all' };
  state.meetings = [];
  state.meeting = null;
  state.createError = null;
  state.google = {
    ...state.google,
    state: 'disconnected',
    email: null,
    calendars: { mine: null, wings: null },
  };
  for (const fn of Object.values(calls)) fn.mockReset();
  vi.restoreAllMocks();
});

describe('meetingToStart', () => {
  it('prefers the meeting in progress, then the next one with a link, never a cancelled one', () => {
    const now = Date.parse('2099-01-10T12:00:00.000Z');
    expect(meetingToStart([], now)).toBeNull();
    expect(meetingToStart([summary({ meetUrl: null })], now)).toBeNull();
    expect(meetingToStart([summary({ status: 'cancelada' })], now)).toBeNull();
    const later = summary({
      id: 'm2',
      startsAt: '2099-01-11T13:00:00.000Z',
      endsAt: '2099-01-11T14:00:00.000Z',
    });
    expect(meetingToStart([later, summary()], now)?.id).toBe('m1');
    const running = summary({ id: 'm3', status: 'em_andamento' });
    expect(meetingToStart([summary(), running], now)?.id).toBe('m3');
  });
});

describe('the Reunião section', () => {
  it('schedules with a pasted link and sends what the API takes', async () => {
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    expect(
      (screen.getByRole('button', { name: 'Iniciar reunião' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    fireEvent.change(screen.getByLabelText(/Link da reunião/), {
      target: { value: 'https://meet.google.com/abc-defg-hij' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar reunião' }));
    await waitFor(() => expect(calls.create).toHaveBeenCalled());
    const sent = calls.create.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(sent).toMatchObject({
      title: '@ Candidato Exemplo ( Marca Exemplo ) - CALL',
      calendar: 'vendedor',
      meetUrl: 'https://meet.google.com/abc-defg-hij',
      createMeet: false,
    });
    expect(typeof sent.startsAt).toBe('string');
    // The form closes on success.
    expect(screen.queryByRole('button', { name: 'Marcar reunião' })).toBeNull();
  });

  it('refuses a link that is not a meeting link before asking the API', () => {
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    fireEvent.change(screen.getByLabelText(/Link da reunião/), {
      target: { value: 'https://exemplo.com/sala' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar reunião' }));
    expect(screen.getByText(/Link de reunião do Google Meet, Zoom ou Teams/)).toBeTruthy();
    expect(calls.create).not.toHaveBeenCalled();
  });

  it('keeps the Google checkbox off and explains how to connect while the person is not connected', () => {
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    const box = screen.getByRole('checkbox', {
      name: /Criar o evento e o Meet/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(false);
    expect(box.disabled).toBe(true);
    expect(screen.getByText('conecte a sua conta Google').getAttribute('href')).toBe(
      '/minha-conta',
    );
  });

  it('creates on Google by default for a connected person, with the team\u2019s title, inviting the lead only when asked', async () => {
    state.google = {
      ...state.google,
      state: 'connected',
      email: 'vendedor@wingscompany.com.br',
      calendars: {
        mine: { id: 'primary', name: 'Vendedor' },
        wings: { id: 'w@group.calendar.google.com', name: 'Wings Company', access: 'writer' },
      },
    };
    render(<MeetingsTab data={loaded('formatacao')} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    const box = screen.getByRole('checkbox', {
      name: /Criar o evento e o Meet/,
    }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    expect(screen.queryByLabelText(/Link da reunião/)).toBeNull();
    expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe(
      '@ Formatação ( Padaria Exemplo - Candidato Exemplo ) - CALL',
    );
    const invite = screen.getByRole('checkbox', {
      name: /Convidar o lead por e-mail/,
    }) as HTMLInputElement;
    expect(invite.checked).toBe(false);
    fireEvent.click(invite);
    fireEvent.change(screen.getByLabelText(/Outros convidados/), {
      target: { value: 'socio@exemplo.com.br, Contador@exemplo.com.br' },
    });
    fireEvent.change(screen.getByLabelText('Agenda'), { target: { value: 'wings' } });
    fireEvent.click(screen.getByRole('button', { name: 'Marcar reunião' }));
    await waitFor(() => expect(calls.create).toHaveBeenCalled());
    expect(calls.create.mock.calls[0]?.[0]).toMatchObject({
      createMeet: true,
      inviteLead: true,
      calendar: 'wings',
      attendees: [{ email: 'socio@exemplo.com.br' }, { email: 'contador@exemplo.com.br' }],
    });
  });

  it('offers no invitation on an Expansão deal with a brand: the Meet link goes by WhatsApp', async () => {
    state.google = { ...state.google, state: 'connected' };
    render(<MeetingsTab data={loaded('expansao')} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    expect((screen.getByLabelText('Título') as HTMLInputElement).value).toBe(
      '@ Candidato Exemplo ( Marca Exemplo ) - CALL',
    );
    expect(screen.queryByRole('checkbox', { name: /Convidar o lead/ })).toBeNull();
    expect(screen.queryByLabelText(/Outros convidados/)).toBeNull();
    const rule = screen.getByTestId('brand-rule');
    expect(rule.textContent).toContain('expansao_lembrete_reuniao');
    expect(rule.querySelector('a')?.getAttribute('href')).toBe(
      '/crm-vendas/negociacoes/l1/whatsapp',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Marcar reunião' }));
    await waitFor(() => expect(calls.create).toHaveBeenCalled());
    expect(calls.create.mock.calls[0]?.[0]).toMatchObject({
      createMeet: true,
      inviteLead: false,
      attendees: [],
    });
  });

  it('blocks the Wings Company calendar when it is not shared with the person', () => {
    state.google = {
      ...state.google,
      state: 'connected',
      calendars: {
        mine: { id: 'primary', name: 'Vendedor' },
        wings: { id: 'w@group.calendar.google.com', name: 'Wings Company', access: 'reader' },
      },
    };
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    fireEvent.change(screen.getByLabelText('Agenda'), { target: { value: 'wings' } });
    expect(screen.getByText(/Você só lê a agenda Wings Company/)).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Marcar reunião' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('falls back to the pasted link, with the hint, when the API answers 503', async () => {
    state.google = { ...state.google, state: 'connected' };
    state.createError = new ApiError(503, {
      error: 'google_needs_reconnect',
      message: 'Sua conexão com o Google expirou',
    });
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    fireEvent.click(screen.getByRole('button', { name: 'Marcar reunião' }));
    await waitFor(() => expect(screen.getByText(/conecte de novo em Minha conta/)).toBeTruthy());
    expect(
      (screen.getByRole('checkbox', { name: /Criar o evento e o Meet/ }) as HTMLInputElement)
        .checked,
    ).toBe(false);
    expect(screen.getByLabelText(/Link da reunião/)).toBeTruthy();
  });

  it('"Iniciar reunião" opens the next meeting with a link beside the Wings', () => {
    state.meetings = [summary()];
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    const start = screen.getByRole('button', { name: 'Iniciar reunião' }) as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    fireEvent.click(start);
    expect(open).toHaveBeenCalledWith(
      'https://meet.google.com/abc-defg-hij',
      'wings-meet',
      expect.stringContaining('popup'),
    );
  });

  it('approves the summary with the exact text on screen, only for who holds the permission', async () => {
    state.meetings = [summary({ status: 'encerrada', analysisState: 'pronta' })];
    state.meeting = meeting();
    const { unmount } = render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reunião de diagnóstico' }));
    expect(screen.getByText('Rascunho — aguarda aprovação')).toBeTruthy();
    expect(screen.getByLabelText('Texto do resumo').textContent).toBe(SUMMARY_TEXT);
    // Without meetings.approve_send: no approve button, only the note.
    expect(screen.queryByRole('button', { name: 'Li e aprovo este texto' })).toBeNull();
    expect(screen.getByText(/A aprovação é de quem tem a permissão/)).toBeTruthy();
    unmount();

    state.permissions = {
      'leads.read': 'all',
      'leads.write': 'all',
      'meetings.approve_send': 'all',
    };
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reunião de diagnóstico' }));
    fireEvent.click(screen.getByRole('button', { name: 'Li e aprovo este texto' }));
    expect(calls.approve).toHaveBeenCalledWith(SUMMARY_TEXT);
  });

  it('edits the draft through the API and never approves while editing', () => {
    state.permissions = {
      'leads.read': 'all',
      'leads.write': 'all',
      'meetings.approve_send': 'all',
    };
    state.meetings = [summary({ status: 'encerrada', analysisState: 'pronta' })];
    state.meeting = meeting();
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reunião de diagnóstico' }));
    fireEvent.click(screen.getByRole('button', { name: 'Editar texto' }));
    expect(screen.queryByRole('button', { name: 'Li e aprovo este texto' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Texto do resumo'), {
      target: { value: `${SUMMARY_TEXT}\n\nAbraço.` },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Salvar texto' }));
    expect(calls.edit).toHaveBeenCalledWith(`${SUMMARY_TEXT}\n\nAbraço.`, expect.anything());
  });

  it('sends once after approval, and shows the sent state', () => {
    state.permissions = {
      'leads.read': 'all',
      'leads.write': 'all',
      'meetings.approve_send': 'all',
    };
    state.meetings = [summary({ status: 'encerrada', analysisState: 'pronta' })];
    state.meeting = meeting({
      summarySend: {
        ...meeting().summarySend!,
        state: 'aprovado',
        approvedBy: 'Diretoria',
        approvedAt: '2026-10-06T13:00:00.000Z',
      },
    });
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reunião de diagnóstico' }));
    expect(screen.getByText('Aprovado — pronto para enviar')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Enviar agora (uma vez)' }));
    expect(calls.send).toHaveBeenCalledTimes(1);
  });

  it('shows no franchisor card on a Formatação deal', () => {
    state.meetings = [summary({ status: 'encerrada', analysisState: 'pronta' })];
    state.meeting = meeting();
    render(<MeetingsTab data={loaded('formatacao')} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reunião de diagnóstico' }));
    expect(screen.queryByText('Resumo para o dono da franqueadora')).toBeNull();
    expect(screen.getByText(/Guardada · 30:00 · 47\.7 MB/)).toBeTruthy();
  });
});
