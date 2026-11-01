import type {
  DealWhatsApp,
  WaCall,
  WaCallPermissionLive,
  WaCallPermissionRequest,
  WaChatNumber,
  WaConversationItem,
  WaInboxFilter,
  WaInboxPage,
  WaInboxQuery,
  WaNewTarget,
  WaBulkImport,
  WaBulkItem,
  WaImportBatch,
  WaImportPreview,
  WaMessage,
  WaTargets,
  WaArtLink,
  WaSendMedia,
  WaSendText,
  WaTemplate,
  WaTemplatePreview,
  WaRingingSnapshot,
  WaTemplateSend,
  WaFieldSpec,
  WaManagedTemplate,
  WaManagedTemplates,
  WaTemplateCreate,
  WaTemplateEdit,
  WaAssignmentMode,
  WaAttendanceView,
} from '@wings/shared';
import { waExportChatOf } from '@wings/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { permissionScope, useSession } from './auth.js';
import { api, ApiError } from './client.js';
import { sendLeadFile } from './crm.js';
import { openRingingStream } from './ringing-stream.js';
import { INBOX_SUMMARY_KEY, inboxStreamDown, receiveInboxSummary } from './whatsapp-inbox.js';

/**
 * The official WhatsApp of the CRM (docs/whatsapp/cloud-api.md). The open
 * conversation refreshes itself every few seconds while the screen is
 * visible — passively, so it never keeps an idle session alive.
 */

const REFRESH_MS = 5_000;

/** A deal's conversation (`leadId`), or one no deal took yet (`conversationId`). */
export type WhatsAppThread = { leadId: string } | { conversationId: string };

const threadPath = (thread: WhatsAppThread) =>
  'leadId' in thread
    ? `/leads/${thread.leadId}/whatsapp`
    : `/whatsapp/conversations/${thread.conversationId}`;

const threadKey = (thread: WhatsAppThread) => ['whatsapp', 'thread', threadPath(thread)] as const;

export function useWhatsAppThread(thread: WhatsAppThread, enabled = true) {
  return useQuery({
    queryKey: threadKey(thread),
    queryFn: () => api.poll<DealWhatsApp>(threadPath(thread)),
    enabled,
    refetchInterval: REFRESH_MS,
  });
}

export function useWhatsAppConversations(unanswered: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'conversations', unanswered],
    queryFn: () =>
      api.poll<{ conversations: WaConversationItem[] }>(
        `/whatsapp/conversations${unanswered ? '?unanswered=1' : ''}`,
      ),
    refetchInterval: 15_000,
  });
}

export type WhatsAppInboxFilter = WaInboxFilter;

/** The Central's selects (docs/whatsapp/central.md), on top of the tab and the search. */
export type WhatsAppInboxNarrow = Partial<
  Pick<WaInboxQuery, 'number' | 'sector' | 'state' | 'from' | 'to'>
>;

/** The reader's WhatsApp list (WhatsApp Web): search, unread per reader, last status. */
/** Whether the official number is live (Eric, 14/10): until then a seller sees WhatsApp as "em breve". */
export function useOfficialNumber(enabled = true) {
  return useQuery({
    queryKey: ['whatsapp', 'official-number'],
    queryFn: () => api.get<{ live: boolean }>('/whatsapp/official-number'),
    enabled,
  });
}

/**
 * A seller's send and call (Eric, 19/10): "em breve" until the official number is live, as the API
 * refuses them (403 `whatsapp_soon`); reading the conversation stays. Not known yet is "not live".
 */
export const WHATSAPP_SOON_TEXT =
  'Em breve: enviar e ligar pelo WhatsApp do sistema começa depois da troca do número. Até lá, use o WhatsApp do celular.';

export function useWhatsAppSoon() {
  const session = useSession();
  const seller = permissionScope(session.data, 'leads.whatsapp') !== 'all';
  const official = useOfficialNumber(seller);
  return seller && official.data?.live !== true;
}

/** The Admin Master's switch, flipped on the day the number is swapped. */
export function useSetOfficialNumber() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (live: boolean) =>
      api.put<{ live: boolean }>('/whatsapp/official-number', { live }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp', 'official-number'] }),
  });
}

/**
 * The Central's list, a page of 50 at a time (`fetchNextPage` for the next): the pages read as one
 * list. Refreshed every 10 s, and at once when the stream says the inbox moved.
 */
export function useWhatsAppInbox(
  filter: WhatsAppInboxFilter,
  q: string,
  narrow: WhatsAppInboxNarrow = {},
) {
  const params = new URLSearchParams({ filter });
  if (q.trim()) params.set('q', q.trim());
  for (const [key, value] of Object.entries(narrow)) if (value) params.set(key, value);
  const query = useInfiniteQuery({
    queryKey: ['whatsapp', 'conversations', 'list', params.toString()],
    queryFn: ({ pageParam }) =>
      api.poll<WaInboxPage>(
        `/whatsapp/conversations?${params}${pageParam ? `&before=${encodeURIComponent(pageParam)}` : ''}`,
      ),
    initialPageParam: '',
    getNextPageParam: (page) => page.next ?? undefined,
    refetchInterval: 10_000,
  });
  return {
    ...query,
    data: query.data && { conversations: query.data.pages.flatMap((page) => page.conversations) },
  };
}

/** The work numbers the reader reaches (their own; every one at full scope). */
export function useChatNumbers() {
  return useQuery({
    queryKey: ['whatsapp', 'chat-numbers'],
    queryFn: () =>
      api.get<{ numbers: (WaChatNumber & { sector: string | null; connected: boolean })[] }>(
        '/whatsapp/chat-numbers',
      ),
    staleTime: 60_000,
  });
}

/** A chat with no deal: the deals of its phone in the reader's reach. */
export function useConversationDeals(id: string, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'conversations', 'deals', id],
    queryFn: () => api.get<{ deals: WaNewTarget[] }>(`/whatsapp/conversations/${id}/deals`),
    enabled,
  });
}

/** The reader joins the chat to one of its phone's deals. */
export function useLinkConversation(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (leadId: string) =>
      api.post<void>(`/whatsapp/conversations/${id}/link`, { leadId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] }),
  });
}

/** "Nova conversa" by a work number: its chat with the deal's phone (nothing is sent). */
export function useStartNumberChat() {
  return useMutation({
    mutationFn: (input: { numberId: string; leadId: string; phone: string }) =>
      api.post<{ conversationId: string }>(
        `/whatsapp/chat-numbers/${input.numberId}/conversations`,
        { leadId: input.leadId, phone: input.phone },
      ),
  });
}

/** One conversation by its id (a deal's or one with no deal), refreshed while open. */
export function useWhatsAppConversation(id: string | undefined) {
  return useQuery({
    queryKey: ['whatsapp', 'conversations', 'one', id],
    queryFn: () => api.poll<DealWhatsApp>(`/whatsapp/conversations/${id}`),
    enabled: Boolean(id),
    refetchInterval: REFRESH_MS,
  });
}

/** Who answers the conversation, what the reader may do, its history (docs/whatsapp/central.md). */
export function useConversationAttendance(id: string | null) {
  return useQuery({
    queryKey: ['whatsapp', 'conversations', 'attendance', id],
    queryFn: () => api.poll<WaAttendanceView>(`/whatsapp/conversations/${id}/attendance`),
    enabled: id !== null,
    // "Está respondendo" lasts seconds: looked at again often while the conversation is open.
    refetchInterval: 10_000,
  });
}

export type AttendanceAction =
  | { kind: 'assign'; employeeId: string | null; queue?: string }
  | { kind: 'resolve' }
  | { kind: 'reopen' }
  | { kind: 'sofia'; action: 'pause' | 'resume' };

/** One change of hands, made on the version the screen saw (a stale one answers 409). */
export function useAttendanceAction(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ version, action }: { version: number; action: AttendanceAction }) => {
      const base = `/whatsapp/conversations/${id}`;
      if (action.kind === 'assign')
        return api.post<void>(`${base}/assign`, {
          version,
          employeeId: action.employeeId,
          ...(action.queue ? { queue: action.queue } : {}),
        });
      if (action.kind === 'sofia')
        return api.post<void>(`${base}/sofia`, { version, action: action.action });
      return api.post<void>(`${base}/${action.kind}`, { version });
    },
    // Refused or done, what the screen shows is looked at again.
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] }),
  });
}

/** The composer says the reader is typing (renewed at most every 20 s while they type). */
export function useReplying(id: string) {
  return useMutation({
    mutationFn: () =>
      api.post<{ replyingName: string | null }>(`/whatsapp/conversations/${id}/replying`),
  });
}

/** Who gets a conversation nobody holds: its queue, or the funnel's rotation. */
export function useAssignmentMode(enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'assignment'],
    queryFn: () => api.get<{ mode: WaAssignmentMode }>('/whatsapp/assignment'),
    enabled,
  });
}

export function useSetAssignmentMode() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (mode: WaAssignmentMode) =>
      api.put<{ mode: WaAssignmentMode }>('/whatsapp/assignment', { mode }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp', 'assignment'] }),
  });
}

/** The reader opened the conversation: its unread count goes to zero, for them only. */
export function useMarkWhatsAppRead() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.passivePost<void>(`/whatsapp/conversations/${id}/read`),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations', 'list'] });
      // Asked again only while the stream is down; when live, the stream brings it.
      void queryClient.invalidateQueries({ queryKey: INBOX_SUMMARY_KEY });
    },
  });
}

/** "Nova conversa": deals and contacts in the reader's scope matching the search. */
export function useWhatsAppTargets(q: string) {
  const term = q.trim();
  return useQuery({
    queryKey: ['whatsapp', 'targets', term],
    queryFn: () => api.get<WaTargets>(`/whatsapp/targets?q=${encodeURIComponent(term)}`),
    enabled: term.length >= 2,
    staleTime: 10_000,
  });
}

/** The official number's approved templates, or with `numberId` that work number's own (its WABA). */
const templatesPath = (numberId: string | null) =>
  `/whatsapp/templates${numberId ? `?numberId=${numberId}` : ''}`;
const templatesKey = (numberId: string | null) => ['whatsapp', 'templates', numberId ?? 'official'];

export function useWhatsAppTemplates(enabled: boolean, numberId: string | null = null) {
  return useQuery({
    queryKey: templatesKey(numberId),
    queryFn: () =>
      api.get<{ templates: WaTemplate[]; configured: boolean; syncError: string | null }>(
        templatesPath(numberId),
      ),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useRefreshWhatsAppTemplates(numberId: string | null = null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api.get<{ templates: WaTemplate[]; configured: boolean; syncError: string | null }>(
        `${templatesPath(numberId)}${numberId ? '&' : '?'}refresh=1`,
      ),
    onSuccess: (data) => queryClient.setQueryData(templatesKey(numberId), data),
  });
}

function afterSend(queryClient: ReturnType<typeof useQueryClient>, thread: WhatsAppThread) {
  void queryClient.invalidateQueries({ queryKey: threadKey(thread) });
  void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'conversations'] });
  // A person writing takes the conversation from Sofia: her screen shows it at once.
  void queryClient.invalidateQueries({ queryKey: ['sofia'] });
}

/** CRM Vendas → WhatsApp → Modelos (docs/whatsapp/modelos.md): every template, read again from Meta. */
export function useManagedTemplates() {
  return useQuery({
    queryKey: ['whatsapp', 'templates', 'manage'],
    queryFn: () => api.get<WaManagedTemplates>('/whatsapp/templates/manage'),
  });
}

function useTemplateWrite<T>(write: (input: T) => Promise<{ template: WaManagedTemplate }>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: write,
    // The prefix covers this screen's list and the sellers' list of approved templates.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['whatsapp', 'templates'] }),
  });
}

export const useCreateTemplate = () =>
  useTemplateWrite((input: WaTemplateCreate) => api.post('/whatsapp/templates/manage', input));

/** New words go back to Meta's review. */
export const useEditTemplate = () =>
  useTemplateWrite(({ id, ...input }: WaTemplateEdit & { id: string }) =>
    api.put(`/whatsapp/templates/manage/${id}`, input),
  );

/** Only what fills each {{n}}: stays in the system, Meta sees nothing. */
export const useSaveTemplateFields = () =>
  useTemplateWrite(({ id, fields }: { id: string; fields: WaFieldSpec[] }) =>
    api.put(`/whatsapp/templates/manage/${id}/fields`, { fields }),
  );

function useSend<T>(thread: WhatsAppThread, kind: 'text' | 'template') {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: T) =>
      api.post<{ message: WaMessage }>(`${threadPath(thread)}/${kind}`, input),
    onSuccess: () => afterSend(queryClient, thread),
  });
}

export const useSendWhatsAppText = (thread: WhatsAppThread) => useSend<WaSendText>(thread, 'text');
export const useSendWhatsAppTemplate = (thread: WhatsAppThread) =>
  useSend<WaTemplateSend>(thread, 'template');

/**
 * A file in the conversation: it goes up to the deal's Arquivos first (`sendLeadFile`), then the
 * conversation sends it by its id. `uploaded` is a file already there (the one of the same name, or
 * this one after a send that failed past the upload): it goes without going up again.
 */
export function useSendWhatsAppFile(thread: WhatsAppThread, leadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File | null;
      uploaded: string | null;
      caption: string;
      onProgress: (fraction: number) => void;
      onUploaded: (fileId: string) => void;
    }) => {
      let fileId = input.uploaded;
      if (!fileId) {
        if (!leadId || !input.file) throw new Error(NO_DEAL_FOR_FILES);
        fileId = (await sendLeadFile({ leadId, file: input.file, onProgress: input.onProgress }))
          .fileId;
        input.onUploaded(fileId);
      }
      const body: WaSendMedia = { fileId, ...(input.caption ? { caption: input.caption } : {}) };
      return api.post<{ message: WaMessage }>(`${threadPath(thread)}/media`, body);
    },
    onSuccess: () => afterSend(queryClient, thread),
    // The deal's Arquivos, its count and timeline show the file that went up, whatever happened after.
    onSettled: () => {
      if (leadId) void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

/**
 * A voice note recorded in the conversation: the recording goes as it is, and the API converts
 * it, keeps it in the deal's Arquivos and sends it as a WhatsApp voice message.
 */
export function useSendWhatsAppVoice(thread: WhatsAppThread, leadId: string | null) {
  const queryClient = useQueryClient();
  return useMutation({
    // The recording's key goes with it: a second try of the same one gets the audio that went.
    mutationFn: (input: { recording: Blob; key: string }) =>
      api.upload<{ message: WaMessage }>(`${threadPath(thread)}/voice`, input.recording, {
        'Idempotency-Key': input.key,
      }),
    onSuccess: () => afterSend(queryClient, thread),
    // The deal's Arquivos show the audio kept there. A refusal by the API kept nothing, so the
    // deals are not read again; a network error may hide a send that went, so they are.
    onSettled: (_data, error) => {
      if (leadId && !(error instanceof ApiError))
        void queryClient.invalidateQueries({ queryKey: ['leads'] });
    },
  });
}

/** Why a conversation with no deal sends no file (the API says the same). */
export const NO_DEAL_FOR_FILES =
  'O arquivo fica nos arquivos da negociação: esta conversa ainda não tem negociação.';

/**
 * What the chosen template becomes now (a common message inside the window,
 * or the approved template), with its fields filled. Read-only: the send
 * decides again on the server.
 */
export function useTemplatePreview(thread: WhatsAppThread, input: WaTemplateSend | null) {
  return useQuery({
    queryKey: ['whatsapp', 'template-preview', threadPath(thread), input],
    queryFn: () =>
      api.post<{ preview: WaTemplatePreview }>(`${threadPath(thread)}/template-preview`, input),
    enabled: input !== null,
    placeholderData: (previous) => previous,
    staleTime: 30_000,
    retry: false,
  });
}

/** The art this conversation's templates carry, for the preview (an address of 5 minutes). */
export function useWhatsAppArt(thread: WhatsAppThread, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'art', threadPath(thread)],
    queryFn: () => api.get<WaArtLink>(`${threadPath(thread)}/art`),
    enabled,
    staleTime: 4 * 60_000,
    retry: false,
  });
}

/** Where the browser opens a received file (the API checks access and fetches it from Meta). */
export const whatsappMediaUrl = (messageId: string) => `/api/whatsapp/messages/${messageId}/media`;

// --- calls ----------------------------------------------------------------------------

/** The person's call permission, asked of Meta now (only when the call panel opens). */
export function useCallPermission(leadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'call-permission', leadId],
    queryFn: () => api.get<WaCallPermissionLive>(`/leads/${leadId}/whatsapp/call-permission`),
    enabled,
    staleTime: 30_000,
    retry: false,
  });
}

/** The call-request template for this deal (outside the window), before it goes. Sends nothing. */
export function useCallRequestPreview(leadId: string, enabled: boolean) {
  return useQuery({
    queryKey: ['whatsapp', 'call-request-preview', leadId],
    queryFn: () =>
      api.post<{ preview: WaTemplatePreview }>(`/leads/${leadId}/whatsapp/call-permission/preview`),
    enabled,
    staleTime: 0,
    retry: false,
  });
}

/** No input: Meta's free request (inside the window); `template`: by the approved template. */
export function useRequestCallPermission(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input?: WaCallPermissionRequest) =>
      api.post<{ message: WaMessage }>(`/leads/${leadId}/whatsapp/call-permission`, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['whatsapp', 'call-permission', leadId] });
      void queryClient.invalidateQueries({ queryKey: threadKey({ leadId }) });
    },
  });
}

const RINGING_KEY = ['whatsapp', 'ringing'] as const;
/** While the stream is down: how often to ask when calling is on, and when it is off. */
const RINGING_FALLBACK_MS = 10_000;
const RINGING_FALLBACK_OFF_MS = 60_000;

/**
 * Calls ringing for the viewer. They arrive by the stream (`ringing-stream.ts`): the
 * whole answer on connect and each time it changes, no request per tab every few
 * seconds. Only while the stream is down does the screen ask for it, slowly (10 s,
 * 60 s when calling is off); the moment an answer comes by the stream the asking stops.
 */
export function useRingingCalls(enabled: boolean) {
  const queryClient = useQueryClient();
  const [live, setLive] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    const close = openRingingStream({
      onSnapshot: (snapshot) => {
        // An ask still on its way would answer older than this: let it go first.
        void queryClient
          .cancelQueries({ queryKey: RINGING_KEY })
          .then(() => queryClient.setQueryData(RINGING_KEY, snapshot));
      },
      // The same stream brings the inbox: the menu's count, and new messages at once.
      onInbox: (summary) => receiveInboxSummary(queryClient, summary),
      onLive: (live) => {
        setLive(live);
        if (!live) inboxStreamDown(queryClient);
      },
    });
    return () => {
      close();
      setLive(false);
      inboxStreamDown(queryClient);
    };
  }, [enabled, queryClient]);

  return useQuery({
    queryKey: RINGING_KEY,
    queryFn: () => api.poll<WaRingingSnapshot>('/whatsapp/calls/ringing'),
    enabled: enabled && !live,
    refetchInterval: (query) =>
      query.state.data?.calling ? RINGING_FALLBACK_MS : RINGING_FALLBACK_OFF_MS,
    refetchIntervalInBackground: true,
  });
}

/** The call steps, run by the call center in order (no cache: each is one action). */
export const whatsappCalls = {
  start: (leadId: string, sdp: string) =>
    api.post<{ call: WaCall }>(`/leads/${leadId}/whatsapp/calls`, { sdp }),
  get: (id: string) => api.poll<{ call: WaCall }>(`/whatsapp/calls/${id}`),
  connected: (id: string) => api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/connected`),
  pickup: (id: string) =>
    api.post<{ offerSdp: string; call: WaCall }>(`/whatsapp/calls/${id}/pickup`),
  accept: (id: string, sdp: string) =>
    api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/accept`, { sdp }),
  reject: (id: string) => api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/reject`),
  hangup: (id: string) => api.post<{ call: WaCall }>(`/whatsapp/calls/${id}/hangup`),
};

// --- a conversation imported from the phone (docs/whatsapp/importar-conversa.md) ---------

/**
 * The text of a phone's export: the `.txt` itself, or the chat inside the `.zip` (`_chat.txt` on
 * the iPhone, "Conversa do WhatsApp com …" on Android). Read here, in the browser, so a `.zip`
 * full of media never has to pass through the API; the server parses the text again.
 */
export async function exportTextOf(file: File): Promise<string> {
  if (!/\.zip$/i.test(file.name) && file.type !== 'application/zip') return file.text();
  const { strFromU8, unzipSync } = await import('fflate');
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => /\.txt$/i.test(entry.name),
  });
  const names = Object.keys(entries);
  const name =
    names.find((n) => /(^|\/)_chat\.txt$/i.test(n)) ??
    names.find((n) => /(^|\/)(conversa do whatsapp|whatsapp chat)/i.test(n)) ??
    names[0];
  if (!name) throw new Error('O .zip não tem a conversa (.txt). Exporte de novo pelo WhatsApp.');
  return strFromU8(entries[name]!);
}

/** The exported file keeps its name with the import's day and time, so a second export of the same chat fits beside it. */
export function stampedFile(file: File, at: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}h${pad(at.getMinutes())}`;
  const dot = file.name.lastIndexOf('.');
  const [base, ext] = dot > 0 ? [file.name.slice(0, dot), file.name.slice(dot)] : [file.name, ''];
  return new File([file], `${base} (importada ${stamp})${ext}`, { type: file.type });
}

/** Above this a bundle `.zip` is not read in the browser: pick the exports themselves, or use the CLI. */
export const WA_BULK_BROWSER_ZIP_MAX = 1024 * 1024 * 1024;

/**
 * "Importar em lote": the conversations in what the Admin picked. A `.txt` or a phone's `.zip`
 * export is one conversation and stays the file it is; a `.zip` of many exports is opened here,
 * in the browser, and each export inside it becomes a file of its own (its media stays inside).
 */
export async function conversationFilesOf(file: File): Promise<File[]> {
  if (/\.txt$/i.test(file.name)) return [file];
  if (!/\.zip$/i.test(file.name)) return [];
  if (file.size > WA_BULK_BROWSER_ZIP_MAX)
    throw new Error(
      `${file.name} passa de 1 GB: escolha as conversas soltas, ou mande a pasta para o CLI.`,
    );
  const { unzipSync } = await import('fflate');
  const wanted = (name: string) =>
    !/(^|\/)__MACOSX\//.test(name) && /\.(txt|zip)$/i.test(name) && !/(^|\/)\./.test(name);
  const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
    filter: (entry) => wanted(entry.name),
  });
  const names = Object.keys(entries);
  if (waExportChatOf(names)) return [file];
  return names.map(
    (name) =>
      new File([entries[name]!], name.split('/').pop()!, {
        type: /\.zip$/i.test(name) ? 'application/zip' : 'text/plain',
      }),
  );
}

const bulkPath = (id: string) => `/whatsapp/bulk-imports/${id}`;

export const bulkImports = {
  create: (nameMap?: string) =>
    api
      .post<{ bulk: WaBulkImport }>('/whatsapp/bulk-imports', nameMap ? { nameMap } : {})
      .then((r) => r.bulk),
  get: (id: string) => api.get<{ bulk: WaBulkImport }>(bulkPath(id)).then((r) => r.bulk),
  addItem: (id: string, input: { fileName: string; byteSize: number; text: string }) =>
    api.post<{ item: WaBulkItem }>(`${bulkPath(id)}/items`, input).then((r) => r.item),
  patchItem: (id: string, itemId: string, patch: { leadId: string } | { skip: boolean }) =>
    api.patch<{ item: WaBulkItem }>(`${bulkPath(id)}/items/${itemId}`, patch).then((r) => r.item),
  pairAgain: (id: string, ourName: string) =>
    api.post<{ bulk: WaBulkImport }>(`${bulkPath(id)}/pair`, { ourName }).then((r) => r.bulk),
  start: (id: string, ourName: string) =>
    api.post<{ bulk: WaBulkImport }>(`${bulkPath(id)}/apply`, { ourName }).then((r) => r.bulk),
  /** The conversation's file first, among the paired deal's files; then its messages. */
  applyItem: async (id: string, item: WaBulkItem, file: File) => {
    const kept = await sendLeadFile({
      leadId: item.leadId!,
      file: stampedFile(file, new Date()),
      onProgress: () => {},
    });
    return api
      .post<{ item: WaBulkItem }>(`${bulkPath(id)}/items/${item.id}/apply`, {
        fileId: kept.fileId,
      })
      .then((r) => r.item);
  },
  undo: (id: string, itemId?: string) =>
    api
      .post<{ bulk: WaBulkImport; undone: number; removed: number }>(
        itemId ? `${bulkPath(id)}/items/${itemId}/undo` : `${bulkPath(id)}/undo`,
      )
      .then((r) => r.bulk),
  discard: (id: string) => api.delete<void>(bulkPath(id)),
  reportUrl: (id: string) => `/api${bulkPath(id)}/report`,
};

const importsKey = (leadId: string) => ['whatsapp', 'imports', leadId] as const;

export function useWhatsAppImports(leadId: string) {
  return useQuery({
    queryKey: importsKey(leadId),
    queryFn: () =>
      api
        .get<{ imports: WaImportBatch[] }>(`/leads/${leadId}/whatsapp/imports`)
        .then((r) => r.imports),
  });
}

/** What the file holds; nothing is written. */
export const previewWhatsAppImport = (leadId: string, text: string) =>
  api
    .post<{ preview: WaImportPreview }>(`/leads/${leadId}/whatsapp/imports/preview`, { text })
    .then((r) => r.preview);

function invalidateImport(queryClient: ReturnType<typeof useQueryClient>, leadId: string) {
  void queryClient.invalidateQueries({ queryKey: ['whatsapp'] });
  void queryClient.invalidateQueries({ queryKey: ['leads', 'one', leadId] });
}

/** The exported file goes to the deal's files first (its media stays in it), then the messages. */
export function useImportWhatsAppConversation(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      file: File;
      text: string;
      ourName: string;
      onProgress: (fraction: number) => void;
    }) => {
      const kept = await sendLeadFile({
        leadId,
        file: stampedFile(input.file, new Date()),
        onProgress: input.onProgress,
      });
      return api
        .post<{ import: WaImportBatch }>(`/leads/${leadId}/whatsapp/imports`, {
          text: input.text,
          ourName: input.ourName,
          fileId: kept.fileId,
        })
        .then((r) => r.import);
    },
    onSettled: () => invalidateImport(queryClient, leadId),
  });
}

export function useUndoWhatsAppImport(leadId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (batchId: string) =>
      api.delete<{ import: WaImportBatch; removed: number }>(
        `/leads/${leadId}/whatsapp/imports/${batchId}`,
      ),
    onSettled: () => invalidateImport(queryClient, leadId),
  });
}

/** The deal's messages before one on screen, a page at a time. */
export const olderWhatsAppMessages = (leadId: string, beforeId: string) =>
  api
    .get<{ messages: WaMessage[] }>(`/leads/${leadId}/whatsapp/messages?before=${beforeId}`)
    .then((r) => r.messages);
