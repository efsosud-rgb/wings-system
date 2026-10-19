import type {
  AgendaCalendarKey,
  AgendaEvent,
  AgendaEventInput,
  AgendaEventPatch,
  AgendaEventsAnswer,
  AgendaOverview,
} from '@wings/shared';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/**
 * Agenda (docs/agenda.md): the person's Google calendar and Wings Company's,
 * read and written through the API with the person's own Google connection.
 * A calendar is named by its key ('mine' | 'wings'), never by its Google id.
 */

export const AGENDA_KEY = ['agenda'];
export const AGENDA_OVERVIEW_KEY = ['agenda', 'overview'];
export const AGENDA_EVENTS_KEY = ['agenda', 'events'];

export function useAgendaOverview() {
  return useQuery({
    queryKey: AGENDA_OVERVIEW_KEY,
    queryFn: () => api.get<{ overview: AgendaOverview }>('/agenda'),
    select: (body) => body.overview,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
}

/** The events between two instants (the visible period), optionally matching a search. */
/** The deal meetings with a pasted link, for the person without Google (Eric, 19/10). */
export function usePastedMeetings(from: string, to: string) {
  return useQuery({
    queryKey: ['agenda', 'crm-meetings', from, to],
    queryFn: () =>
      api
        .get<{ events: AgendaEvent[] }>(`/agenda/crm-meetings?${new URLSearchParams({ from, to })}`)
        .then((r) => r.events),
  });
}

export function useAgendaEvents(from: string, to: string, q?: string, enabled = true) {
  return useQuery({
    queryKey: [...AGENDA_EVENTS_KEY, from, to, q ?? ''],
    queryFn: () => {
      const params = new URLSearchParams({ from, to });
      if (q) params.set('q', q);
      return api.get<AgendaEventsAnswer>(`/agenda/events?${params.toString()}`);
    },
    enabled,
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    // The period on screen keeps its events while the next one loads.
    placeholderData: keepPreviousData,
  });
}

const eventPath = (calendar: AgendaCalendarKey, id: string) =>
  `/agenda/events/${calendar}/${encodeURIComponent(id)}`;

export function useCreateAgendaEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: AgendaEventInput) =>
      api.post<{ event: AgendaEvent }>('/agenda/events', input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AGENDA_EVENTS_KEY }),
  });
}

export function useUpdateAgendaEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { calendar: AgendaCalendarKey; id: string; patch: AgendaEventPatch }) =>
      api.patch<{ event: AgendaEvent }>(eventPath(input.calendar, input.id), input.patch),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AGENDA_EVENTS_KEY }),
  });
}

export function useDeleteAgendaEvent() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { calendar: AgendaCalendarKey; id: string }) =>
      api.delete<unknown>(eventPath(input.calendar, input.id)),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: AGENDA_EVENTS_KEY }),
  });
}
