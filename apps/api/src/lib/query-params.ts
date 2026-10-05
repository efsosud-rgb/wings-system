/**
 * The parameters of a session `value` from RD Station's `traffic_source`: a
 * landing URL, a bare query string ("utm_source=…&utm_campaign=…", how RD keeps
 * paid traffic) or a label such as "(direct)" that carries none.
 */
export function paramsOfAddress(value: string | null | undefined): URLSearchParams {
  if (!value) return new URLSearchParams();
  try {
    return new URL(value).searchParams;
  } catch {
    return value.includes('=')
      ? new URLSearchParams(value.trim().replace(/^\?/, ''))
      : new URLSearchParams();
  }
}
