import type {
  Board,
  BoardCard,
  CrmBrand,
  CrmCompany,
  CrmCompanyInput,
  CrmCompanyUpdateInput,
  CrmContact,
  CrmContactInput,
  CrmContactUpdateInput,
  CrmDuplicatePair,
  CrmRelatedLead,
  CrmSavedView,
  CrmSavedViewCreateInput,
  CsvImportPreview,
  CsvImportReport,
  CsvImportRequest,
  LeadActivity,
  LeadActivityCreateInput,
  LeadAiSummary,
  LeadDealUpdateInput,
  LeadFile,
  LeadListItem,
  LeadListQuery,
  LeadPipeline,
  LeadTask,
  LeadTaskKind,
  Meeting,
  MeetingSummary,
  SalesDashboard,
  DriveUploadTicket,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';
import type { LoadedLead } from './leads.js';

/** CRM Vendas since the redesign of 05/10/2026: Negociações, Contatos, Empresas, Tarefas. */

/** The filters of Negociações, as the screen keeps them (strings; the API parses). */
export type DealFilter = Partial<Record<keyof LeadListQuery, string>> & { mine?: string };

export function filterParams(filter: DealFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(filter)) if (value) params.set(key, value);
  return params;
}

function invalidateDeals(queryClient: ReturnType<typeof useQueryClient>) {
  void queryClient.invalidateQueries({ queryKey: ['leads'] });
  void queryClient.invalidateQueries({ queryKey: ['crm'] });
}

// --- sales panel (Dashboard › Vendas) -------------------------------------------------

export function useSalesDashboard(query: Record<string, string>) {
  const params = new URLSearchParams(query);
  return useQuery({
    queryKey: ['crm', 'dashboard', params.toString()],
    queryFn: () => api.get<SalesDashboard>(`/crm/dashboard?${params.toString()}`),
    placeholderData: (previous) => previous,
  });
}

// --- board ------------------------------------------------------------------------------

export function useDealBoard(pipeline: LeadPipeline, filter: DealFilter) {
  const params = filterParams(filter);
  params.set('pipeline', pipeline);
  return useQuery({
    queryKey: ['leads', 'board', pipeline, filter],
    queryFn: () => api.get<Board>(`/leads/board?${params.toString()}`),
    placeholderData: (previous) => previous,
  });
}

export function useLoadColumn() {
  return useMutation({
    mutationFn: (input: {
      pipeline: LeadPipeline;
      stageId: string | null;
      offset: number;
      filter: DealFilter;
    }) => {
      const params = filterParams(input.filter);
      params.set('pipeline', input.pipeline);
      params.set('stageId', input.stageId ?? 'none');
      params.set('offset', String(input.offset));
      return api.get<{ cards: BoardCard[] }>(`/leads/board/column?${params.toString()}`);
    },
  });
}

export function useDealCounters(pipeline: LeadPipeline) {
  return useQuery({
    queryKey: ['leads', 'counters', pipeline],
    queryFn: () =>
      api.get<{ untouched: number; today: number; overdue: number }>(
        `/leads/board/counters?pipeline=${pipeline}`,
      ),
  });
}

export function useDealList(filter: DealFilter) {
  const params = filterParams(filter);
  const query = params.toString();
  return useQuery({
    queryKey: ['leads', 'list', filter],
    queryFn: () =>
      api.get<{ leads: LeadListItem[]; total: number }>(`/leads${query ? `?${query}` : ''}`),
    placeholderData: (previous) => previous,
  });
}

/** Move, close or hand over a deal from a card (the same PATCH as its page). */
export function useDealQuickChange() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      ...input
    }: {
      id: string;
      stageId?: string;
      won?: boolean | null;
      lostReason?: string;
      ownerEmployeeId?: string | null;
    }) => api.patch<LoadedLead>(`/leads/${id}`, input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

// --- saved views ----------------------------------------------------------------------

export function useSavedViews() {
  return useQuery({
    queryKey: ['crm', 'views'],
    queryFn: () => api.get<{ views: CrmSavedView[] }>('/crm/views'),
  });
}

export function useSaveView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CrmSavedViewCreateInput) =>
      api.post<{ view: CrmSavedView }>('/crm/views', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm', 'views'] }),
  });
}

export function useDeleteView() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete<void>(`/crm/views/${id}`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm', 'views'] }),
  });
}

// --- the deal's page -------------------------------------------------------------------

export function useUpdateDeal(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadDealUpdateInput) => api.patch<LoadedLead>(`/leads/${id}/deal`, input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

export function useAddActivity(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: LeadActivityCreateInput) =>
      api.post<{ activity: LeadActivity }>(`/leads/${id}/activities`, input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

export function useLinkContact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { contactId?: string; contact?: CrmContactInput; primary?: boolean }) =>
      api.post<LoadedLead>(`/leads/${id}/contacts`, input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

export function useUnlinkContact(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (contactId: string) => api.delete<LoadedLead>(`/leads/${id}/contacts/${contactId}`),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

// --- contacts and companies ----------------------------------------------------------------

export function useContacts(q: string, duplicates = false) {
  return useQuery({
    queryKey: ['crm', 'contacts', q, duplicates],
    queryFn: () =>
      api.get<{ contacts: CrmContact[]; duplicates: CrmDuplicatePair<CrmContact>[] }>(
        `/crm/contacts?${duplicates ? 'duplicates=true' : `q=${encodeURIComponent(q)}`}`,
      ),
  });
}

export function useContact(id: string | undefined) {
  return useQuery({
    queryKey: ['crm', 'contact', id],
    queryFn: () => api.get<{ contact: CrmContact; leads: CrmRelatedLead[] }>(`/crm/contacts/${id}`),
    enabled: Boolean(id),
  });
}

export function useCreateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CrmContactInput) =>
      api.post<{ contact: CrmContact; created: boolean }>('/crm/contacts', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm'] }),
  });
}

export function useUpdateContact() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CrmContactUpdateInput & { id: string }) =>
      api.patch<{ contact: CrmContact }>(`/crm/contacts/${id}`, input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

export function useMergeContacts() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fromId: string; intoId: string }) =>
      api.post<{ contact: CrmContact }>('/crm/contacts/merge', input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

export function useCompanies(q: string, duplicates = false) {
  return useQuery({
    queryKey: ['crm', 'companies', q, duplicates],
    queryFn: () =>
      api.get<{ companies: CrmCompany[]; duplicates: CrmDuplicatePair<CrmCompany>[] }>(
        `/crm/companies?${duplicates ? 'duplicates=true' : `q=${encodeURIComponent(q)}`}`,
      ),
  });
}

export function useCompany(id: string | undefined) {
  return useQuery({
    queryKey: ['crm', 'company', id],
    queryFn: () =>
      api.get<{ company: CrmCompany; leads: CrmRelatedLead[]; contacts: CrmContact[] }>(
        `/crm/companies/${id}`,
      ),
    enabled: Boolean(id),
  });
}

export function useCreateCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CrmCompanyInput) =>
      api.post<{ company: CrmCompany; created: boolean }>('/crm/companies', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm'] }),
  });
}

export function useUpdateCompany() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...input }: CrmCompanyUpdateInput & { id: string }) =>
      api.patch<{ company: CrmCompany }>(`/crm/companies/${id}`, input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

export function useMergeCompanies() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { fromId: string; intoId: string }) =>
      api.post<{ company: CrmCompany }>('/crm/companies/merge', input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

export function useCompanyToClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; relationship: 'formatacao' | 'expansao' | 'ambos' }) =>
      api.post<{ company: CrmCompany; clientId: string; created: boolean }>(
        `/crm/companies/${input.id}/client`,
        { relationship: input.relationship },
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['crm'] });
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
    },
  });
}

// --- brands of interest --------------------------------------------------------------------

export function useBrands(all = false) {
  return useQuery({
    queryKey: ['crm', 'brands', all],
    queryFn: () => api.get<{ brands: CrmBrand[] }>(`/crm/brands${all ? '?all=true' : ''}`),
  });
}

export function useCreateBrand() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { name: string }) => api.post<{ brand: CrmBrand }>('/crm/brands', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm', 'brands'] }),
  });
}

export function useSetBrandOnSale() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { clientId: string; onSale: boolean }) =>
      api.patch<{ brand: CrmBrand }>(`/crm/brands/${input.clientId}`, { onSale: input.onSale }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['crm', 'brands'] }),
  });
}

// --- tasks -----------------------------------------------------------------------------

export function useTaskList(input: {
  status: 'open' | 'overdue' | 'done' | 'all';
  everyone: boolean;
  assignee?: string;
  kind?: LeadTaskKind | '';
}) {
  const params = new URLSearchParams({ status: input.status });
  if (input.everyone) params.set('everyone', 'true');
  if (input.assignee) params.set('assignee', input.assignee);
  if (input.kind) params.set('kind', input.kind);
  return useQuery({
    queryKey: ['crm', 'tasks', input],
    queryFn: () => api.get<{ tasks: LeadTask[] }>(`/crm/tasks?${params.toString()}`),
  });
}

export function useCompleteTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { leadId: string; taskId: string; done: boolean }) =>
      api.patch<{ task: LeadTask }>(`/leads/${input.leadId}/tasks/${input.taskId}`, {
        done: input.done,
      }),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

// --- CSV ---------------------------------------------------------------------------------

export function usePreviewImport() {
  return useMutation({
    mutationFn: (input: { csv: string; mapping?: CsvImportRequest['mapping'] }) =>
      api.post<CsvImportPreview>('/leads/import/preview', input),
  });
}

export function useRunImport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CsvImportRequest) => api.post<CsvImportReport>('/leads/import', input),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

/** Downloads the filtered list; the browser saves the file the API names. */
export async function downloadExport(filter: DealFilter): Promise<void> {
  const params = filterParams(filter);
  const response = await fetch(`/api/leads/export.csv?${params.toString()}`, {
    credentials: 'include',
  });
  if (!response.ok) throw new Error('export_failed');
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = `negociacoes-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

// --- where deals come from ---------------------------------------------------------------------

export interface DealSource {
  key: string;
  name: string;
  state: 'on' | 'off' | 'soon';
  note: string;
  lastAt: string | null;
  last30: number;
}

export function useDealSources() {
  return useQuery({
    queryKey: ['crm', 'sources'],
    queryFn: () => api.get<{ sources: DealSource[] }>('/crm/sources'),
  });
}

// --- files of a deal (ficha do cliente, Etapa 3) ----------------------------------------

export const useLeadFiles = (id: string) =>
  useQuery({
    queryKey: ['leads', id, 'files'],
    queryFn: () => api.get<{ files: LeadFile[] }>(`/leads/${id}/files`).then((r) => r.files),
  });

/**
 * One file to the deal, start to finish: the server picks the deal's folder in
 * the Drive and hands an address; the bytes go there (not to the API); then
 * the server checks they arrived and links the file to the deal.
 */
export async function sendLeadFile(input: {
  leadId: string;
  file: File;
  onProgress: (fraction: number) => void;
}): Promise<LeadFile> {
  const { ticket } = await api.post<{ ticket: DriveUploadTicket }>(
    `/leads/${input.leadId}/files/uploads`,
    {
      name: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      byteSize: input.file.size,
    },
  );
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open(ticket.method, ticket.url);
    for (const [name, value] of Object.entries(ticket.headers)) {
      request.setRequestHeader(name, value);
    }
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) input.onProgress(event.loaded / event.total);
    };
    request.onload = () =>
      request.status >= 200 && request.status < 300
        ? resolve()
        : reject(new Error('O armazenamento recusou o arquivo. Tente de novo.'));
    request.onerror = () => reject(new Error('A conexão caiu durante o envio. Tente de novo.'));
    request.send(input.file);
  });
  input.onProgress(1);
  const { file } = await api.post<{ file: LeadFile }>(
    `/leads/${input.leadId}/files/uploads/${ticket.uploadId}/complete`,
  );
  return file;
}

/** Sends one file to the deal; afterwards the list, the count on the right and the timeline read again. */
export function useSendLeadFile(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { file: File; onProgress: (fraction: number) => void }) =>
      sendLeadFile({ leadId: id, ...input }),
    onSettled: () => invalidateDeals(queryClient),
  });
}

export function useRemoveLeadFile(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (fileId: string) => api.delete(`/leads/${id}/files/${fileId}`),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

// --- the AI summary of a deal (ficha do cliente, Etapa 4) ---------------------------------

export function useGenerateSummary(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<{ summary: LeadAiSummary }>(`/leads/${id}/resumo`),
    onSuccess: () => invalidateDeals(queryClient),
  });
}

/** One question about the deal, answered from the same record; nothing is stored. */
export const useAskDeal = (id: string) =>
  useMutation({
    mutationFn: (question: string) =>
      api.post<{ answer: string; model: string }>(`/leads/${id}/resumo/pergunta`, { question }),
  });

// --- meetings of a deal (docs/crm/reunioes-api.md) ----------------------------------------

/**
 * The deal's meetings. The API is the Opus's (contract in docs/crm/reunioes-api.md);
 * until it is on, the route answers 404 and the screen shows "—" with the reason.
 */
export const useMeetings = (leadId: string) =>
  useQuery({
    queryKey: ['leads', leadId, 'meetings'],
    queryFn: () =>
      api.get<{ meetings: MeetingSummary[] }>(`/leads/${leadId}/meetings`).then((r) => r.meetings),
    retry: false,
  });

export const useMeeting = (id: string | null) =>
  useQuery({
    queryKey: ['meetings', id],
    queryFn: () => api.get<{ meeting: Meeting }>(`/meetings/${id}`).then((r) => r.meeting),
    enabled: id !== null,
    retry: false,
  });

/** One click turns a next step of the analysis into a task of the deal. */
export function useNextStepTask(meetingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (index: number) =>
      api.post<{ task: LeadTask }>(`/meetings/${meetingId}/next-steps/${index}/task`),
    onSuccess: () => {
      invalidateDeals(queryClient);
      void queryClient.invalidateQueries({ queryKey: ['meetings', meetingId] });
    },
  });
}
