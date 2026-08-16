/**
 * Extract query parameters from a URL string without constructing a URL object.
 * Always returns a fresh, caller-owned instance.
 */
export function getSearchParams(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  if (idx === -1) return new URLSearchParams();
  return new URLSearchParams(url.substring(idx + 1));
}
