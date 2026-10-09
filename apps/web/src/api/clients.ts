import {
  WA_ART_HEIGHT,
  WA_ART_REFUSALS,
  WA_ART_WIDTH,
  waArtRefusal,
  type BrandArticle,
  type Client,
  type ClientAddress,
  type ClientCompany,
  type ClientCreateInput,
  type ClientPartnerInput,
  type ClientRecord,
  type ClientWhatsAppArt,
  type DriveUploadTicket,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from './client.js';

/** Who work is done for: Wings Company first, then the rest. Read by the studio, kept in Administração. */
export function useClients(enabled = true) {
  return useQuery({
    queryKey: ['clients'],
    queryFn: () => api.get<{ clients: Client[] }>('/clients'),
    enabled,
    staleTime: 60_000,
  });
}

export function useCreateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ClientCreateInput) => api.post<{ client: Client }>('/clients', input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['clients'] }),
  });
}

export function useUpdateClient() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { id: string; name?: string; active?: boolean; number?: number }) =>
      api.patch<{ client: Client }>(`/clients/${input.id}`, {
        name: input.name,
        active: input.active,
        number: input.number,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['clients'] });
      // Asset rows carry the client's name; the Drive's folders carry its number and name.
      void queryClient.invalidateQueries({ queryKey: ['media', 'assets'] });
      void queryClient.invalidateQueries({ queryKey: ['drive'] });
    },
  });
}

// --- the full record ("ficha") -------------------------------------------------------

export function useClientRecord(id: string) {
  return useQuery({
    queryKey: ['clients', id, 'record'],
    queryFn: () => api.get<ClientRecord>(`/clients/${id}/record`),
    retry: false,
  });
}

export type ClientRecordBlockPath =
  'company' | 'contacts' | 'business' | 'contracts' | 'franchise' | 'signature';

/** Saves one block; the answer is the whole record again, with its new %. */
export function useSaveClientBlock<T>(id: string, block: ClientRecordBlockPath) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: T) => api.put<ClientRecord>(`/clients/${id}/${block}`, payload),
    onSuccess: (record) => {
      queryClient.setQueryData(['clients', id, 'record'], record);
      void queryClient.invalidateQueries({ queryKey: ['clients'], exact: true });
    },
  });
}

export function useSavePartner(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({
      partnerId,
      payload,
    }: {
      partnerId: string | null;
      payload: ClientPartnerInput;
    }) =>
      partnerId
        ? api.put<ClientRecord>(`/clients/${id}/partners/${partnerId}`, payload)
        : api.post<ClientRecord>(`/clients/${id}/partners`, payload),
    onSuccess: (record) => queryClient.setQueryData(['clients', id, 'record'], record),
  });
}

export function useDeletePartner(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (partnerId: string) =>
      api.delete<ClientRecord>(`/clients/${id}/partners/${partnerId}`),
    onSuccess: (record) => queryClient.setQueryData(['clients', id, 'record'], record),
  });
}

/** The full CPF of a partner or witness. Audited on the server, never cached here. */
export function useRevealClientCpf(id: string) {
  return useMutation({
    mutationFn: (input: { kind: 'partner' | 'witness'; id: string }) =>
      api.post<{ cpf: string }>(`/clients/${id}/reveal-cpf`, input),
  });
}

export interface CnpjLookup {
  source: 'brasilapi' | 'receitaws';
  registrationStatus: string | null;
  company: Partial<ClientCompany>;
  partners: { name: string; role: string | null }[];
}

export function useCnpjLookup() {
  return useMutation({
    mutationFn: (cnpj: string) => api.post<CnpjLookup>('/clients/lookup/cnpj', { cnpj }),
  });
}

export function useCepLookup() {
  return useMutation({
    mutationFn: (cep: string) =>
      api.post<{ source: string; address: ClientAddress }>('/clients/lookup/cep', { cep }),
  });
}

// --- the WhatsApp header: the art and the article (docs/whatsapp/arte-modelos.md) ----------

const whatsappKey = (id: string) => ['clients', id, 'whatsapp'] as const;

/** The client's art (an address of 5 minutes) and article. */
export function useClientWhatsApp(id: string, enabled = true) {
  return useQuery({
    queryKey: whatsappKey(id),
    queryFn: () => api.get<ClientWhatsAppArt>(`/clients/${id}/whatsapp`),
    enabled,
    // The image address lasts 5 minutes: asked again before it runs out.
    staleTime: 4 * 60_000,
    refetchInterval: 4 * 60_000,
    retry: false,
  });
}

export function useSetClientArticle(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (article: BrandArticle | null) =>
      api.put<ClientWhatsAppArt>(`/clients/${id}/whatsapp/article`, { article }),
    onSuccess: (state) => {
      queryClient.setQueryData(whatsappKey(id), state);
      void queryClient.invalidateQueries({ queryKey: ['clients'], exact: true });
    },
  });
}

/** Width and height as the browser reads them; null where it cannot (the server checks again). */
async function imageSize(file: File): Promise<{ width: number; height: number } | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch {
    return null;
  }
}

/**
 * The art, start to finish: checked here first (type, size, dimensions),
 * then sent straight to storage and confirmed; the server reads the bytes
 * and refuses with the reason when they are not the art.
 */
export function useUploadClientArt(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const size = await imageSize(file);
      const refused = waArtRefusal({
        type: file.type || null,
        byteSize: file.size,
        width: size?.width ?? WA_ART_WIDTH,
        height: size?.height ?? WA_ART_HEIGHT,
      });
      if (refused) throw new Error(WA_ART_REFUSALS[refused]);
      const { ticket } = await api.post<{ ticket: DriveUploadTicket }>(
        `/clients/${id}/whatsapp/art/uploads`,
        { mimeType: file.type, byteSize: file.size },
      );
      const sent = await fetch(ticket.url, {
        method: ticket.method,
        headers: ticket.headers,
        body: file,
      }).catch(() => null);
      if (!sent?.ok) throw new Error('O armazenamento recusou o arquivo. Tente de novo.');
      return api.post<ClientWhatsAppArt>(
        `/clients/${id}/whatsapp/art/uploads/${ticket.uploadId}/complete`,
      );
    },
    onSuccess: (state) => {
      queryClient.setQueryData(whatsappKey(id), state);
      void queryClient.invalidateQueries({ queryKey: ['clients'], exact: true });
    },
  });
}

export function useRemoveClientArt(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<ClientWhatsAppArt>(`/clients/${id}/whatsapp/art`),
    onSuccess: (state) => {
      queryClient.setQueryData(whatsappKey(id), state);
      void queryClient.invalidateQueries({ queryKey: ['clients'], exact: true });
    },
  });
}
