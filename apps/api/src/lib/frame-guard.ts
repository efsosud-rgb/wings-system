/**
 * Clickjacking defence: only this system may show its answers inside a frame.
 * Nothing of ours is framed by another site (the landing pages `/lp/<slug>` are
 * opened directly), and the frames the web shows are Meta's previews and
 * pre-signed storage links, which carry their own headers. The web's nginx
 * sends the same pair (`docker/web-security-headers.conf`).
 */
export const FRAME_ANCESTORS = "frame-ancestors 'self'";
export const X_FRAME_OPTIONS = 'SAMEORIGIN';

/** The Content-Security-Policy to send: a route's own policy keeps its rules and gains this one. */
export function withFrameAncestors(csp: string | undefined): string {
  if (!csp) return FRAME_ANCESTORS;
  return /(^|;)\s*frame-ancestors\b/i.test(csp) ? csp : `${csp}; ${FRAME_ANCESTORS}`;
}
