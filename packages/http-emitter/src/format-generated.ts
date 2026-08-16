import { format } from "oxfmt";

export interface GeneratedFilePlan {
  readonly fileName: string;
  readonly outputDir: string;
  readonly raw: string;
}

export interface FormattedGeneratedFile {
  readonly fileName: string;
  readonly outputDir: string;
  readonly content: string;
}

export type GeneratedTypeScriptFormatter = (fileName: string, content: string) => Promise<string>;

export class GeneratedFileFormatError extends Error {
  readonly fileName: string;
  readonly outputDir: string;

  constructor(file: GeneratedFilePlan, cause: unknown) {
    super(errorMessage(cause), { cause });
    this.name = "GeneratedFileFormatError";
    this.fileName = file.fileName;
    this.outputDir = file.outputDir;
  }
}

export async function formatGeneratedTypeScript(
  fileName: string,
  content: string,
): Promise<string> {
  const result = await format(fileName, content);
  if (result.errors.length > 0) {
    const messages = [...new Set(result.errors.map((error) => error.message).filter(Boolean))];
    throw new Error(messages.join("; ") || "The formatter reported an unknown error.");
  }
  return result.code;
}

export async function formatGeneratedFiles(
  files: readonly GeneratedFilePlan[],
  formatter: GeneratedTypeScriptFormatter = formatGeneratedTypeScript,
): Promise<FormattedGeneratedFile[]> {
  const formatted: FormattedGeneratedFile[] = [];
  for (const file of files) {
    try {
      formatted.push({
        fileName: file.fileName,
        outputDir: file.outputDir,
        content: await formatter(file.fileName, file.raw),
      });
    } catch (error) {
      throw new GeneratedFileFormatError(file, error);
    }
  }
  return formatted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
