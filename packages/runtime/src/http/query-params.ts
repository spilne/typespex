const EMPTY_SEARCH = new URLSearchParams();

/**
 * Extract query parameters from a URL string without constructing a URL object.
 * Returns a shared empty instance when there's no query string.
 */
export function getSearchParams(url: string): URLSearchParams {
  const idx = url.indexOf("?");
  if (idx === -1) return EMPTY_SEARCH;
  return new URLSearchParams(url.substring(idx + 1));
}
