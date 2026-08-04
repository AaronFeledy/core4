import { cp, mkdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";

const SCHEMA_FAMILIES = ["schemas", "command-schemas"] as const;

type MirrorSchemaArtifactsInput = {
  readonly repoRoot: string;
};

class CanonicalSchemaArtifactTreeError extends Error {
  readonly sourcePath: string;

  constructor(sourcePath: string) {
    super(`Canonical schema artifact tree is not a directory: ${sourcePath}`);
    this.name = "CanonicalSchemaArtifactTreeError";
    this.sourcePath = sourcePath;
  }
}

export const mirrorSchemaArtifacts = async ({ repoRoot }: MirrorSchemaArtifactsInput): Promise<void> => {
  const trees = SCHEMA_FAMILIES.map((family) => ({
    source: resolve(repoRoot, "dist", family),
    mirror: resolve(repoRoot, "core/dist", family),
  }));

  await Promise.all(
    trees.map(async ({ source }) => {
      if (!(await stat(source)).isDirectory()) throw new CanonicalSchemaArtifactTreeError(source);
    }),
  );

  for (const { source, mirror } of trees) {
    await rm(mirror, { recursive: true, force: true });
    await mkdir(mirror, { recursive: true });
    await cp(source, mirror, { recursive: true });
  }
};
