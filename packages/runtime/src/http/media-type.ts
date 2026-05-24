/**
 * Parses the bare media type from a Content-Type header value, dropping
 * parameters such as `; charset=utf-8` or `; boundary=...`. Returns the
 * lowercased `type/subtype` or `undefined` when no parsable value is present.
 */
export function parseMediaType(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  const semi = header.indexOf(";");
  const raw = (semi === -1 ? header : header.substring(0, semi)).trim().toLowerCase();
  return raw.length === 0 ? undefined : raw;
}

/**
 * Returns true when `received` matches one of `declared`. Each declared
 * entry is compared by bare `type/subtype` (parameters ignored) and may use
 * a `*` subtype wildcard such as `image/*` or the catch-all `*\/*`.
 */
export function isContentTypeAccepted(
  received: string | null | undefined,
  declared: readonly string[],
): boolean {
  if (declared.length === 0) return true;
  const receivedMedia = parseMediaType(received);
  if (!receivedMedia) return false;
  for (const allowed of declared) {
    if (matchesMediaType(receivedMedia, allowed)) return true;
  }
  return false;
}

function matchesMediaType(received: string, declared: string): boolean {
  const declaredMedia = parseMediaType(declared);
  if (!declaredMedia) return false;
  if (declaredMedia === received) return true;

  const dSlash = declaredMedia.indexOf("/");
  if (dSlash === -1) return false;
  const dType = declaredMedia.substring(0, dSlash);
  const dSub = declaredMedia.substring(dSlash + 1);

  if (dType === "*" && dSub === "*") return true;

  const rSlash = received.indexOf("/");
  if (rSlash === -1) return false;
  const rType = received.substring(0, rSlash);

  if (dSub === "*") return rType === dType;
  return false;
}
