/**
 * The request line kept in the logs: the path only. A query string can carry
 * a webhook secret (`?secret=`, the one way RD Station can send it) or a
 * person's data, so it never reaches a log.
 */
export function loggedUrl(url: string): string {
  const query = url.indexOf('?');
  return query === -1 ? url : url.slice(0, query);
}
