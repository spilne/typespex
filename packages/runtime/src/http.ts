/**
 * Extract query parameters from a URL string without constructing a URL object.
 * Returns a URLSearchParams instance for the familiar .get()/.has() API.
 */
export function getSearchParams(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  if (idx === -1) return new URLSearchParams();
  return new URLSearchParams(url.substring(idx + 1));
}
