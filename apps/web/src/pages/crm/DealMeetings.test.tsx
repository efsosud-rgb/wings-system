import {
  WHATSAPP_OPT_IN_MISSING_TEXT,
  type GoogleWorkspaceStatus,
  type Lead,
  type Meeting,
  type MeetingSummary,
} from '@wings/shared';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
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
    step: vi.fn(),
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
      // What the create answers on success ("Reunião agora" reads its id and Meet link).
      createResult: null as Meeting | null,
      // A create still waiting for Google, when a test holds it.
      createPending: null as Promise<Meeting> | null,
      // What "Iniciar"/"Encerrar" answers on success, and the error it can show.
      stepResult: null as Meeting | null,
      stepError: null as unknown,
      // What the Google status query answers instead of its default (a failed request).
      googleQuery: {} as Record<string, unknown>,
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
  useGoogleStatus: () => ({
    data: { status: state.google },
    isPending: false,
    isLoading: false,
    isError: false,
    ...state.googleQuery,
  }),
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
    mutateAsync: (input: unknown) => {
      calls.create(input);
      return (
        state.createPending ??
        (state.createError
          ? Promise.reject(state.createError)
          : Promise.resolve(state.createResult))
      );
    },
  }),
  useUpdateMeeting: () => mutation(calls.update),
  useMeetingStep: () => ({
    isPending: false,
    error: state.stepError,
    mutate: (input: unknown, options?: { onSuccess?: (meeting: Meeting) => void }) => {
      calls.step(input);
      if (state.stepResult) options?.onSuccess?.(state.stepResult);
    },
    mutateAsync: (input: unknown) => {
      calls.step(input);
      return Promise.resolve(state.stepResult);
    },
  }),
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

const { MeetingsTab, meetingToStart, NOW_MEETING_MINUTES } = await import('./DealMeetings.js');

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
      phone: '5521999990001',
      brand: pipeline === 'expansao' ? 'Marca Exemplo' : null,
      fields: { instagram: null, website: null, companyName: 'Padaria Exemplo', cnpj: null },
      origin: { source: 'site_form' },
      consent: { legalBasis: null },
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
  state.createResult = null;
  state.createPending = null;
  state.stepResult = null;
  state.stepError = null;
  state.googleQuery = {};
  state.google = {
    ...state.google,
    state: 'disconnected',
    email: null,
    calendars: { mine: null, wings: null },
  };
  for (const fn of Object.values(calls)) fn.mockReset();
  vi.restoreAllMocks();
});

describe('the Google status in the scheduling form', () => {
  it('says why it could not check, instead of asking to connect an account that may be connected', () => {
    state.googleQuery = { data: undefined, isError: true, error: new ApiError(500, {}) };
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Agendar reunião' }));
    expect(
      screen.getByText(/não foi possível conferir a conexão com o Google/).textContent,
    ).toContain('erro 500');
    expect(screen.queryByText('conecte a sua conta Google')).toBeNull();
  });
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

  it('does not block "Minha agenda" when only the Wings Company calendar is not shared', () => {
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
    expect((screen.getByLabelText('Agenda') as HTMLSelectElement).value).toBe('vendedor');
    expect(screen.queryByText(/Você só lê a agenda Wings Company/)).toBeNull();
    expect(
      (screen.getByRole('button', { name: 'Marcar reunião' }) as HTMLButtonElement).disabled,
    ).toBe(false);
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

  it('asks inside the page before cancelling a meeting, never with window.confirm', () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    state.meetings = [summary({ googleEventId: 'evt1' })];
    state.meeting = meeting({ status: 'agendada', googleEventId: 'evt1' });
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Reunião de diagnóstico' }));
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar reunião' }));
    const ask = screen.getByRole('alertdialog', { name: 'Cancelar esta reunião?' });
    expect(ask.textContent).toContain('Ela sai do Google Agenda e os convidados são avisados.');
    fireEvent.click(screen.getByRole('button', { name: 'Voltar' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(calls.update).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Cancelar reunião' }));
    const again = screen.getByRole('alertdialog');
    fireEvent.click(within(again).getByRole('button', { name: 'Cancelar reunião' }));
    expect(calls.update).toHaveBeenCalledWith({ status: 'cancelada' });
    expect(confirmSpy).not.toHaveBeenCalled();
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

describe('Iniciar and Encerrar record on the deal', () => {
  const NO_RECORDING = { state: 'nenhuma', fileId: null, durationSeconds: null, sizeBytes: null };

  it('"Iniciar reunião" opens the Meet and starts the scheduled meeting for who can write', () => {
    state.meetings = [summary()];
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar reunião' }));
    expect(open).toHaveBeenCalledWith(
      'https://meet.google.com/abc-defg-hij',
      'wings-meet',
      expect.stringContaining('popup'),
    );
    expect(calls.step).toHaveBeenCalledTimes(1);
    expect(calls.step).toHaveBeenCalledWith({ id: 'm1', step: 'start' });
    // Not yet under way as far as this screen knows: it still reads Iniciar, with no Encerrar.
    expect(screen.queryByRole('button', { name: 'Encerrar reunião' })).toBeNull();
  });

  it('opens the Meet but records nothing for who cannot write', () => {
    state.meetings = [summary()];
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MeetingsTab data={loaded()} canWrite={false} onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Iniciar reunião' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls.step).not.toHaveBeenCalled();
  });

  it('a meeting under way reads "Voltar ao Meet" and offers "Encerrar reunião"', () => {
    state.meetings = [summary({ status: 'em_andamento' })];
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Iniciar reunião' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Encerrar reunião' })).toBeTruthy();
    // Going back to the Meet opens the window and does not start it again.
    fireEvent.click(screen.getByRole('button', { name: 'Voltar ao Meet' }));
    expect(open).toHaveBeenCalledTimes(1);
    expect(calls.step).not.toHaveBeenCalled();
  });

  it('shows no "Encerrar reunião" to who cannot write', () => {
    state.meetings = [summary({ status: 'em_andamento' })];
    render(<MeetingsTab data={loaded()} canWrite={false} onRegisterHeld={() => {}} />);
    expect(screen.getByRole('button', { name: 'Voltar ao Meet' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Encerrar reunião' })).toBeNull();
  });

  it('"Encerrar reunião" ends it, says it was recorded, asks for the recording and opens the meeting', () => {
    state.meetings = [summary({ status: 'em_andamento' })];
    // What the API answers to the end, and then what the opened meeting reads.
    const ended = meeting({
      status: 'encerrada',
      recordingState: 'nenhuma',
      recording: NO_RECORDING,
      analysisState: 'nenhuma',
      summarySendState: 'nenhum',
    } as Partial<Meeting>);
    state.stepResult = ended;
    state.meeting = ended;
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    expect(screen.queryByText(/Reunião encerrada e registrada/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Encerrar reunião' }));
    expect(calls.step).toHaveBeenCalledWith({ id: 'm1', step: 'end' });
    expect(screen.getByRole('status').textContent).toContain(
      'Reunião encerrada e registrada na negociação. Envie a gravação abaixo',
    );
    // The meeting opens on its detail, which takes the recording.
    expect(
      screen.getByRole('button', { name: 'Reunião de diagnóstico' }).getAttribute('aria-expanded'),
    ).toBe('true');
    expect(screen.getByText('Nenhuma gravação enviada.')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Enviar gravação' })).toBeTruthy();
  });

  it('says why it could not record, and shows no success text', () => {
    state.meetings = [summary({ status: 'em_andamento' })];
    state.stepError = new ApiError(409, {
      error: 'meeting_not_started',
      message: 'Esta reunião já foi encerrada.',
    });
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    expect(screen.getByText('Esta reunião já foi encerrada.')).toBeTruthy();
    expect(screen.queryByText(/Reunião encerrada e registrada/)).toBeNull();
  });

  it('marks an ended meeting without a recording with "falta a gravação", and only then', () => {
    state.meetings = [
      summary({ id: 'm1', title: 'Sem gravação', status: 'encerrada', recordingState: 'nenhuma' }),
      summary({ id: 'm2', title: 'Gravada', status: 'encerrada', recordingState: 'guardada' }),
      summary({ id: 'm3', title: 'Marcada', status: 'agendada', recordingState: 'nenhuma' }),
    ];
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    const chips = screen.getAllByText('falta a gravação');
    expect(chips).toHaveLength(1);
    expect(chips[0]!.closest('li')?.textContent).toContain('Sem gravação');
  });
});

describe('Enviar link do Meet', () => {
  it("opens the seller's WhatsApp on the lead's chat with the next meeting's link written", () => {
    state.meetings = [summary()];
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Enviar link do Meet' }));
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target] = open.mock.calls[0]!;
    expect(target).toBe('_blank');
    const link = new URL(String(url));
    expect(`${link.origin}${link.pathname}`).toBe('https://wa.me/5521999990001');
    const text = link.searchParams.get('text') ?? '';
    expect(text).toContain('https://meet.google.com/abc-defg-hij');
    expect(text).toContain('10/01/2099 às 10:00');
    // An Expansão lead with a brand never sees the Wings.
    expect(text).not.toMatch(/wings/i);
    // Nothing is recorded: the seller sends it, or not, in the WhatsApp.
    expect(calls.step).not.toHaveBeenCalled();
  });

  it('is off without a meeting with a link, or without a phone, and absent for who cannot write', () => {
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    const send = screen.getByRole('button', { name: 'Enviar link do Meet' }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    expect(send.title).toBe('Nenhuma reunião com link para enviar');
    cleanup();

    state.meetings = [summary()];
    const noPhone = loaded();
    noPhone.lead = { ...noPhone.lead, phone: null };
    render(<MeetingsTab data={noPhone} canWrite onRegisterHeld={() => {}} />);
    const off = screen.getByRole('button', { name: 'Enviar link do Meet' }) as HTMLButtonElement;
    expect(off.disabled).toBe(true);
    expect(off.title).toBe('A negociação não tem telefone');
    cleanup();

    // A prospecting lead without the WhatsApp opt-in on record.
    const noOptIn = loaded('formatacao');
    noOptIn.lead = {
      ...noOptIn.lead,
      origin: { ...noOptIn.lead.origin, source: 'google_places' },
      consent: { ...noOptIn.lead.consent, legalBasis: 'legitimate_interest' },
    };
    render(<MeetingsTab data={noOptIn} canWrite onRegisterHeld={() => {}} />);
    const blocked = screen.getByRole('button', {
      name: 'Enviar link do Meet',
    }) as HTMLButtonElement;
    expect(blocked.disabled).toBe(true);
    expect(blocked.title).toBe(WHATSAPP_OPT_IN_MISSING_TEXT);
    cleanup();

    render(<MeetingsTab data={loaded()} canWrite={false} onRegisterHeld={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Enviar link do Meet' })).toBeNull();
  });
});

describe('Reunião agora', () => {
  const NOW_URL = 'https://meet.google.com/now-meet-xyz';
  // The beside window as the browser hands it back: opened empty, sent to the Meet later.
  const fakeWindow = (closed = false) => ({
    opener: {} as unknown,
    closed,
    location: { replace: vi.fn() },
    close: vi.fn(),
  });
  const clickNow = () => fireEvent.click(screen.getByRole('button', { name: 'Reunião agora' }));

  it('creates a Meet now on the clicker’s own calendar, without inviting the lead, opens it beside and starts it', async () => {
    state.google = { ...state.google, state: 'connected' };
    state.createResult = meeting({ id: 'now1', status: 'agendada', meetUrl: NOW_URL });
    const win = fakeWindow();
    const open = vi.spyOn(window, 'open').mockImplementation(() => win as unknown as Window);
    render(<MeetingsTab data={loaded('formatacao')} canWrite onRegisterHeld={() => {}} />);
    clickNow();

    // The window opens inside the click, empty and named like Iniciar's, then goes to the Meet.
    expect(open).toHaveBeenCalledTimes(1);
    const [url, target, features] = open.mock.calls[0]!;
    expect(url).toBe('');
    expect(target).toBe('wings-meet');
    expect(features).toContain('popup');
    expect(win.opener).toBeNull();

    expect(calls.create).toHaveBeenCalledTimes(1);
    const input = calls.create.mock.calls[0]![0] as Record<string, unknown>;
    expect(input).toMatchObject({
      title: '@ Formatação ( Padaria Exemplo - Candidato Exemplo ) - CALL',
      calendar: 'vendedor',
      attendees: [],
      meetUrl: null,
      createMeet: true,
      inviteLead: false,
    });
    const startsAt = Date.parse(String(input.startsAt));
    expect(Math.abs(startsAt - Date.now())).toBeLessThan(5_000);
    expect(Date.parse(String(input.endsAt)) - startsAt).toBe(NOW_MEETING_MINUTES * 60_000);

    await waitFor(() => expect(win.location.replace).toHaveBeenCalledWith(NOW_URL));
    // Started like Iniciar, so the deal records the start (and later the end) the same way.
    expect(calls.step).toHaveBeenCalledWith({ id: 'now1', step: 'start' });
    expect(screen.getByRole('status').textContent).toContain(
      'Meet criado na sua agenda Google e aberto ao lado. O lead não foi convidado',
    );
  });

  it('reads "Criando o Meet…" and takes no second click until the meeting is started', async () => {
    state.google = { ...state.google, state: 'connected' };
    let answer: (meeting: Meeting) => void = () => {};
    state.createPending = new Promise<Meeting>((resolve) => (answer = resolve));
    vi.spyOn(window, 'open').mockImplementation(() => fakeWindow() as unknown as Window);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    const busy = screen.getByRole('button', { name: 'Criando o Meet…' }) as HTMLButtonElement;
    expect(busy.disabled).toBe(true);
    fireEvent.click(busy);
    expect(calls.create).toHaveBeenCalledTimes(1);

    answer(meeting({ id: 'now1', status: 'agendada', meetUrl: NOW_URL }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Reunião agora' })).toBeTruthy());
    expect(calls.step).toHaveBeenCalledWith({ id: 'now1', step: 'start' });
  });

  it('asks to connect the Google account before asking Google anything, and opens no window', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    expect(open).not.toHaveBeenCalled();
    expect(calls.create).not.toHaveBeenCalled();
    expect(screen.getByText(/Conecte a sua conta Google em Minha conta/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir Minha conta' }).getAttribute('href')).toBe(
      '/minha-conta',
    );
    cleanup();

    state.google = { ...state.google, state: 'needs_reconnect' };
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    expect(screen.getByText(/conecte de novo em Minha conta/)).toBeTruthy();
    cleanup();

    // The system without Google is Eric's step: no link that would not help.
    state.google = { ...state.google, configured: false, state: 'disconnected' };
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    expect(screen.getByText(/O Google ainda não foi configurado no sistema/)).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Abrir Minha conta' })).toBeNull();
    expect(calls.create).not.toHaveBeenCalled();
    state.google = { ...state.google, configured: true };
  });

  it('asks the API when the connection could not be checked, and closes the window on its 503', async () => {
    state.googleQuery = { data: undefined, isError: true, error: new ApiError(500, {}) };
    state.createError = new ApiError(503, {
      error: 'google_needs_reconnect',
      message: 'Sua conexão com o Google expirou',
    });
    const win = fakeWindow();
    vi.spyOn(window, 'open').mockImplementation(() => win as unknown as Window);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    expect(calls.create).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(win.close).toHaveBeenCalledTimes(1));
    expect(win.location.replace).not.toHaveBeenCalled();
    expect(screen.getByText(/conecte de novo em Minha conta/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Abrir Minha conta' })).toBeTruthy();
    expect(calls.step).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('says what Google refused, with no account link, and records nothing', async () => {
    state.google = { ...state.google, state: 'connected' };
    state.createError = new ApiError(502, {
      error: 'meet_failed',
      message: 'O Google criou o evento mas não gerou o Meet; a reunião não foi marcada.',
    });
    const win = fakeWindow();
    vi.spyOn(window, 'open').mockImplementation(() => win as unknown as Window);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    await waitFor(() => expect(screen.getByText(/não gerou o Meet/)).toBeTruthy());
    expect(win.close).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('link', { name: 'Abrir Minha conta' })).toBeNull();
    expect(calls.step).not.toHaveBeenCalled();
  });

  it('still starts it when the window was blocked or closed meanwhile, and says how to open it', async () => {
    state.google = { ...state.google, state: 'connected' };
    state.createResult = meeting({ id: 'now1', status: 'agendada', meetUrl: NOW_URL });
    vi.spyOn(window, 'open').mockImplementation(() => null);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    await waitFor(() => expect(calls.step).toHaveBeenCalledWith({ id: 'now1', step: 'start' }));
    expect(screen.getByRole('status').textContent).toContain(
      'a janela ao lado não abriu: clique em Voltar ao Meet',
    );
    cleanup();

    const closed = fakeWindow(true);
    vi.spyOn(window, 'open').mockImplementation(() => closed as unknown as Window);
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    clickNow();
    await waitFor(() => expect(screen.getByRole('status').textContent).toContain('não abriu'));
    expect(closed.location.replace).not.toHaveBeenCalled();
  });

  it('is absent for who cannot write, and off while a meeting is under way or the list is unknown', () => {
    render(<MeetingsTab data={loaded()} canWrite={false} onRegisterHeld={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Reunião agora' })).toBeNull();
    cleanup();

    state.meetings = [summary({ status: 'em_andamento' })];
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    const now = screen.getByRole('button', { name: 'Reunião agora' }) as HTMLButtonElement;
    expect(now.disabled).toBe(true);
    expect(now.title).toBe('Já há uma reunião em andamento: volte ao Meet ou encerre');
    cleanup();

    state.meetings = undefined as unknown as MeetingSummary[];
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    expect(
      (screen.getByRole('button', { name: 'Reunião agora' }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it('copies the link of the meeting Iniciar opens, for anyone who sees it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    render(<MeetingsTab data={loaded()} canWrite onRegisterHeld={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Copiar link do Meet' })).toBeNull();
    cleanup();

    state.meetings = [summary({ status: 'em_andamento' })];
    render(<MeetingsTab data={loaded()} canWrite={false} onRegisterHeld={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: 'Copiar link do Meet' }));
    expect(writeText).toHaveBeenCalledWith('https://meet.google.com/abc-defg-hij');
    await waitFor(() => expect(screen.getByText('Copiado')).toBeTruthy());
  });
});
