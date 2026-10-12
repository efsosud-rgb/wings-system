import { ApiError } from '../api/client.js';

/** An API message, as the tail of "Não foi possível carregar X: …": no final stop, lower case. */
function asReason(message: string): string {
  const text = message.trim().replace(/[.!]+$/, '');
  return /^[A-ZÀ-Ý][a-zà-ÿ]/.test(text) ? text.charAt(0).toLowerCase() + text.slice(1) : text;
}

/**
 * Why a screen has nothing to show, in a few plain words for the person.
 *
 * A failed request must never look like an empty list ("Nenhuma tarefa…"): the
 * person would conclude there is nothing to do. Screens show "—" and this reason
 * instead. The words come from the kind of failure; only for a refusal the API
 * explains itself (a 404 naming what is missing, a 4xx with a message) do they
 * come from the API's own user-facing message, which by rule carries no personal
 * data. Any other error's text is never shown.
 */
export function failureReason(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 401) return 'sua sessão expirou';
    if (error.status === 403) return 'você não tem permissão para ver isto';
    // The API names what is missing ("Nenhuma conta de anúncios configurada."); say that when it does.
    if (error.status === 404) {
      return error.body.message ? asReason(error.body.message) : 'não foi encontrado';
    }
    if (error.status === 429) return 'muitas consultas seguidas, tente de novo em instantes';
    if (error.status >= 500) return `o servidor teve um problema (erro ${error.status})`;
    if (error.code === 'bad_response') return 'o servidor respondeu algo inesperado';
    return asReason(error.message);
  }
  // `fetch` rejects with a TypeError when the network is down or the server is unreachable.
  if (error instanceof TypeError) return 'sem conexão com o servidor';
  return 'erro inesperado';
}
