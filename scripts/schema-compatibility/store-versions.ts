import { type SchemaArtifactSet, SchemaCompatibilityInputError } from "../schema-compatibility-artifacts.ts";
import type { PersistedStoreId } from "./model.ts";

const STORE_VERSION_SOURCES = {
  "applied-state": [
    { path: "container-runtime/src/applied-state-migrate.ts", pattern: /APPLIED_STATE_VERSION\s*=\s*(\d+)/ },
  ],
  "tunnel-registry": [
    { path: "engine/src/tunnel/registry-migrate.ts", pattern: /TUNNEL_REGISTRY_VERSION\s*=\s*(\d+)/ },
    { path: "engine/src/tunnel/registry.ts", pattern: /version:\s*(\d+)/ },
  ],
} as const;

export const loadBasePersistedStoreVersions = async (
  repoRoot: string,
  baseRef: string,
  artifacts: SchemaArtifactSet = new Map(),
): Promise<Readonly<Partial<Record<PersistedStoreId, number>>>> => {
  const versions: Partial<Record<PersistedStoreId, number>> = {};
  for (const { persistedState } of artifacts.values()) {
    if (persistedState !== undefined) versions[persistedState.store] = persistedState.version;
  }
  for (const store of ["applied-state", "tunnel-registry"] as const) {
    if (versions[store] !== undefined) continue;
    for (const source of STORE_VERSION_SOURCES[store]) {
      const child = Bun.spawn(["git", "show", `${baseRef}:${source.path}`], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, text, error] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);
      if (exitCode !== 0) {
        if (error.includes("does not exist in") || error.includes("exists on disk, but not in")) continue;
        throw new SchemaCompatibilityInputError(`Cannot read ${store} version at ${baseRef}.`, error);
      }
      const match = source.pattern.exec(text);
      if (match?.[1] === undefined) {
        throw new SchemaCompatibilityInputError(`Cannot determine ${store} version from ${source.path}.`);
      }
      versions[store] = Number(match[1]);
      break;
    }
  }
  return versions;
};
