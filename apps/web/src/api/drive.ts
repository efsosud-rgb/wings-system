import type {
  DriveFile,
  DriveFileVersion,
  DriveFolder,
  DriveLink,
  DriveSyncResult,
  DriveTemplateKind,
  DriveTemplateNode,
  DriveDepartment,
  DriveUploadTicket,
} from '@wings/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ApiError, api } from './client.js';

/**
 * The Drive. What comes back is already what this person may see: the screen
 * never filters folders by itself. File bytes do not go through these calls:
 * `sendFile` puts them straight into storage, at the address the server gave.
 */

export interface DriveTree {
  folders: DriveFolder[];
  maxFileBytes: number;
  storageAvailable: boolean;
}

export const useDriveTree = () =>
  useQuery({ queryKey: ['drive', 'tree'], queryFn: () => api.get<DriveTree>('/drive/tree') });

export const useDriveFolder = (id: string | null) =>
  useQuery({
    queryKey: ['drive', 'folder', id],
    queryFn: () => api.get<{ folder: DriveFolder; files: DriveFile[] }>(`/drive/folders/${id}`),
    enabled: id !== null,
  });

export interface DriveSearch {
  q?: string;
  clientId?: string;
  tag?: string;
}
export const isSearching = (search: DriveSearch) =>
  Boolean(search.q?.trim() || search.clientId || search.tag?.trim());

export function useDriveSearch(search: DriveSearch) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(search)) {
    if (typeof value === 'string' && value.trim() !== '') query.set(key, value.trim());
  }
  const text = query.toString();
  return useQuery({
    queryKey: ['drive', 'search', text],
    queryFn: () => api.get<{ files: DriveFile[] }>(`/drive/search?${text}`),
    enabled: isSearching(search),
  });
}

export const useDriveTrash = (enabled: boolean) =>
  useQuery({
    queryKey: ['drive', 'trash'],
    queryFn: () => api.get<{ files: DriveFile[] }>('/drive/trash'),
    enabled,
  });

export const useDriveVersions = (fileId: string | null) =>
  useQuery({
    queryKey: ['drive', 'versions', fileId],
    queryFn: () => api.get<{ versions: DriveFileVersion[] }>(`/drive/files/${fileId}/versions`),
    enabled: fileId !== null,
  });

/** A short address for one file. Asked for at the moment of use: it lasts five minutes. */
export const driveLink = (fileId: string, disposition: 'inline' | 'attachment', version?: number) =>
  api.get<DriveLink>(
    `/drive/files/${fileId}/link?disposition=${disposition}${version ? `&version=${version}` : ''}`,
  );

function useDriveMutation<Input, Output>(run: (input: Input) => Promise<Output>) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: run,
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['drive'] }),
  });
}

export const useCreateFolder = () =>
  useDriveMutation((input: { parentId: string; name: string }) =>
    api.post<{ folder: DriveFolder }>('/drive/folders', input),
  );
export const useUpdateFolder = () =>
  useDriveMutation((input: { id: string; name?: string; parentId?: string }) =>
    api.patch<{ folder: DriveFolder }>(`/drive/folders/${input.id}`, {
      name: input.name,
      parentId: input.parentId,
    }),
  );
export const useDeleteFolder = () =>
  useDriveMutation((id: string) => api.delete<unknown>(`/drive/folders/${id}`));

export const useUpdateFile = () =>
  useDriveMutation((input: { id: string; name?: string; folderId?: string; tags?: string[] }) =>
    api.patch<{ file: DriveFile }>(`/drive/files/${input.id}`, {
      name: input.name,
      folderId: input.folderId,
      tags: input.tags,
    }),
  );
export const useTrashFile = () =>
  useDriveMutation((id: string) => api.post<{ file: DriveFile }>(`/drive/files/${id}/trash`));
export const useRestoreFile = () =>
  useDriveMutation((id: string) => api.post<{ file: DriveFile }>(`/drive/files/${id}/restore`));
export const usePurgeFile = () =>
  useDriveMutation((id: string) => api.delete<unknown>(`/drive/files/${id}`));

// ---------------------------------------------------------------------------
// Uploading
// ---------------------------------------------------------------------------

export class NameTakenError extends Error {
  constructor(readonly existingFileId: string) {
    super('Já existe um arquivo com este nome nesta pasta.');
    this.name = 'NameTakenError';
  }
}

/**
 * One file, start to finish: ask for an address, send the bytes THERE (not to
 * the API) reporting progress, and tell the server to go and check. The file
 * exists only after that last step answers.
 */
export async function sendFile(input: {
  folderId: string;
  file: File;
  replaceFileId?: string;
  onProgress: (fraction: number) => void;
  signal?: AbortSignal;
}): Promise<DriveFile> {
  let ticket: DriveUploadTicket;
  try {
    ({ ticket } = await api.post<{ ticket: DriveUploadTicket }>('/drive/uploads', {
      folderId: input.folderId,
      name: input.file.name,
      mimeType: input.file.type || 'application/octet-stream',
      byteSize: input.file.size,
      replaceFileId: input.replaceFileId,
    }));
  } catch (error) {
    const existing =
      error instanceof ApiError && error.code === 'name_taken'
        ? (error.body as { existingFileId?: string }).existingFileId
        : undefined;
    if (existing) throw new NameTakenError(existing);
    throw error;
  }

  await new Promise<void>((resolve, reject) => {
    // XMLHttpRequest, because fetch still cannot report how much of a body has gone.
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
    request.onabort = () => reject(new Error('Envio cancelado.'));
    input.signal?.addEventListener('abort', () => request.abort());
    request.send(input.file);
  });
  input.onProgress(1);

  const { file } = await api.post<{ file: DriveFile }>(
    `/drive/uploads/${ticket.uploadId}/complete`,
  );
  return file;
}

// ---------------------------------------------------------------------------
// The folder model
// ---------------------------------------------------------------------------

export const useDriveTemplate = () =>
  useQuery({
    queryKey: ['drive', 'template'],
    queryFn: () => api.get<{ nodes: DriveTemplateNode[] }>('/drive/template'),
  });
export const useCreateTemplateNode = () =>
  useDriveMutation(
    (input: {
      parentId: string | null;
      name: string;
      kind: DriveTemplateKind;
      department?: DriveDepartment;
    }) => api.post<{ node: DriveTemplateNode }>('/drive/template', input),
  );
export const useUpdateTemplateNode = () =>
  useDriveMutation((input: { id: string; name?: string; department?: DriveDepartment }) =>
    api.patch<{ node: DriveTemplateNode }>(`/drive/template/${input.id}`, {
      name: input.name,
      department: input.department,
    }),
  );
export const useDeleteTemplateNode = () =>
  useDriveMutation((id: string) => api.delete<unknown>(`/drive/template/${id}`));
export const useSyncDrive = () => useDriveMutation(() => api.post<DriveSyncResult>('/drive/sync'));
