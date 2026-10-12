import { ApiError } from '../api/client.js';

/**
 * Why a screen has nothing to show, in a few plain words for the person.
 *
 * A failed request must never look like an empty list ("Nenhuma tarefa…"): the
 * person would conclude there is nothing to do. Screens show "—" and this reason
 * instead. The words never come from the request or from the answer's content,
 * only from the kind of failure, so no personal data can end up on screen or in a log.
 */
export function failureReason(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'sua sessão expirou';
    if (error.status === 403) return 'você não tem permissão para ver isto';
    if (error.status === 404) return 'não foi encontrado';
    if (error.status === 429) return 'muitas consultas seguidas, tente de novo em instantes';
    if (error.status >= 500) return `o servidor teve um problema (erro ${error.status})`;
    if (error.code === 'bad_response') return 'o servidor respondeu algo inesperado';
    return error.message;
  }
  // `fetch` rejects with a TypeError when the network is down or the server is unreachable.
  if (error instanceof TypeError) return 'sem conexão com o servidor';
  return 'erro inesperado';
}
