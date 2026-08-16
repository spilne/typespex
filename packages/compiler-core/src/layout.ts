import { camelCase, kebabCase, pascalCase } from "./naming.js";

export type ServiceOutputLayout = "auto" | "flat" | "prefix" | "directory";

export interface ServiceLayoutOptions {
  readonly "service-output"?: ServiceOutputLayout;
  readonly "service-folder-pattern"?: string;
  readonly "file-name-pattern"?: string;
}

export interface ServiceLayout<FileKey extends string> {
  readonly outputDir: string;
  readonly fileNames: Readonly<Record<FileKey, string>>;
}

/** Resolves the layout contract shared by TypeSpex protocol emitters. */
export function createServiceLayout<FileKey extends string>(
  serviceName: string,
  files: Readonly<Record<FileKey, string>>,
  options: ServiceLayoutOptions = {},
): ServiceLayout<FileKey> {
  const output =
    options["service-output"] === "auto" || !options["service-output"]
      ? "directory"
      : options["service-output"];
  const tokens: Readonly<Record<string, string>> = {
    service: serviceName,
    "service.camel": camelCase(serviceName),
    "service.kebab": kebabCase(serviceName),
    "service.pascal": pascalCase(serviceName),
    "service.snake": kebabCase(serviceName).replaceAll("-", "_"),
  };
  const folderPattern = options["service-folder-pattern"] ?? "{service.kebab}";
  const filePattern =
    options["file-name-pattern"] ?? (output === "prefix" ? "{service}.{file}" : "{file}");
  const render = (pattern: string, file = "") =>
    renderPatternTokens(pattern, file, tokens).replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    outputDir: output === "directory" ? render(folderPattern) : "",
    fileNames: Object.fromEntries(
      Object.entries<string>(files).map(([key, file]) => [key, render(filePattern, file)]),
    ) as Record<FileKey, string>,
  };
}

function renderPatternTokens(
  pattern: string,
  file: string,
  tokens: Readonly<Record<string, string>>,
): string {
  const rendered: string[] = [];
  let cursor = 0;
  while (cursor < pattern.length) {
    const openingBrace = pattern.indexOf("{", cursor);
    if (openingBrace === -1) {
      rendered.push(pattern.slice(cursor));
      break;
    }
    rendered.push(pattern.slice(cursor, openingBrace));

    const closingBrace = pattern.indexOf("}", openingBrace + 1);
    if (closingBrace === -1) {
      rendered.push(pattern.slice(openingBrace));
      break;
    }
    const rawToken = pattern.slice(openingBrace + 1, closingBrace);
    if (rawToken.length === 0) {
      rendered.push("{}");
    } else {
      const token = rawToken.trim();
      rendered.push(token === "file" ? file : (tokens[token] ?? ""));
    }
    cursor = closingBrace + 1;
  }
  return rendered.join("");
}
