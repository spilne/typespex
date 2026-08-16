import { format } from "oxfmt";
import type { ArtifactPlan } from "./plans.js";

export class ArtifactCollisionError extends Error {
  constructor(
    readonly path: string,
    readonly first: string,
    readonly second: string,
  ) {
    super(`Artifacts ${JSON.stringify(first)} and ${JSON.stringify(second)} both target ${path}.`);
    this.name = "ArtifactCollisionError";
  }
}

export class ArtifactFormatError extends Error {
  constructor(
    readonly artifact: string,
    readonly fileName: string,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "ArtifactFormatError";
  }
}

export function assertUniqueArtifactPaths(artifacts: readonly ArtifactPlan[]): void {
  const owners = new Map<string, string>();
  for (const artifact of artifacts) {
    const path = `${artifact.outputDir}/${artifact.fileName}`.replaceAll("\\", "/");
    const key = path.toLowerCase();
    const owner = owners.get(key);
    if (owner) throw new ArtifactCollisionError(path, owner, artifact.artifact);
    owners.set(key, artifact.artifact);
  }
}

export async function formatTypeScriptArtifacts(
  artifacts: readonly ArtifactPlan[],
): Promise<ArtifactPlan[]> {
  const formatted: ArtifactPlan[] = [];
  for (const artifact of artifacts) {
    try {
      const result = await format(artifact.fileName, artifact.content);
      if (result.errors.length > 0) {
        throw new Error(result.errors.map((error) => error.message).join("; "));
      }
      formatted.push({ ...artifact, content: result.code });
    } catch (error) {
      throw new ArtifactFormatError(artifact.artifact, artifact.fileName, error);
    }
  }
  return formatted;
}
