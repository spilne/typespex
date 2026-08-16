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
    pattern
      .replace(/\{([^}]+)\}/g, (_match, token: string) =>
        token.trim() === "file" ? file : (tokens[token.trim()] ?? ""),
      )
      .replace(/[^A-Za-z0-9._-]/g, "-");
  return {
    outputDir: output === "directory" ? render(folderPattern) : "",
    fileNames: Object.fromEntries(
      Object.entries<string>(files).map(([key, file]) => [key, render(filePattern, file)]),
    ) as Record<FileKey, string>,
  };
}
