export function extractLiteralQuery(
  uriTemplate: string,
): { readonly name: string; readonly value: string }[] {
  let depth = 0;
  let queryStart = -1;
  for (let index = 0; index < uriTemplate.length; index += 1) {
    const character = uriTemplate[index];
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === "?" && depth === 0) {
      queryStart = index + 1;
      break;
    }
  }
  if (queryStart < 0) return [];
  const literal = uriTemplate
    .slice(queryStart)
    .split("#", 1)[0]!
    .replaceAll(/\{[^}]*\}/g, "")
    .replace(/^&+|&+$/g, "");
  if (!literal) return [];
  return [...new URLSearchParams(literal)].map(([name, value]) => ({ name, value }));
}

export function hasLiteralFragment(uriTemplate: string): boolean {
  let depth = 0;
  for (const character of uriTemplate) {
    if (character === "{") depth += 1;
    else if (character === "}") depth = Math.max(0, depth - 1);
    else if (character === "#" && depth === 0) return true;
  }
  return false;
}
