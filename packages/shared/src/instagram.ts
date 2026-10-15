/**
 * The brand's Instagram username from what a person types: `@marca`, `marca`
 * or the profile address, with or without `https://` and `www.`. Kept
 * import-free so a public page can bundle it without the rest of this package
 * (`@wings/shared/instagram`).
 */
export function instagramUsernameOf(value: string | null | undefined): string | null {
  const username = (value ?? '')
    .trim()
    .replace(/^(https?:\/\/)?(www\.)?instagram\.com\//i, '')
    .replace(/^@+/, '')
    .split(/[/?#\s]/)[0]
    ?.toLowerCase();
  if (!username || username.length > 30) return null;
  if (!/^[a-z0-9._]+$/.test(username) || username.endsWith('.') || username.includes('..')) {
    return null;
  }
  return username;
}
