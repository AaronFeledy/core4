import { dirname, relative, resolve } from "node:path";

import type { WorkspaceManifest } from "./types.ts";

export interface WorkspaceManifestReader {
  manifests(): Promise<ReadonlyArray<WorkspaceManifest>>;
}

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const dependencyNames = (value: unknown): ReadonlyArray<string> =>
  (isJsonObject(value) ? Object.keys(value) : []).sort();

const toPosix = (path: string): string => path.replaceAll("\\", "/");

const readManifest = async (root: string, file: string): Promise<WorkspaceManifest | undefined> => {
  const bunFile = Bun.file(file);
  if (!(await bunFile.exists())) return undefined;
  const parsed: unknown = JSON.parse(await bunFile.text());
  if (!isJsonObject(parsed) || typeof parsed.name !== "string") {
    throw new TypeError(`Invalid workspace package manifest: ${file}`);
  }
  const packageRoot = dirname(file);
  return {
    packageName: parsed.name,
    packageRoot,
    relativeRoot: toPosix(relative(root, packageRoot)),
    dependencies: dependencyNames(parsed.dependencies),
    devDependencies: dependencyNames(parsed.devDependencies),
    peerDependencies: dependencyNames(parsed.peerDependencies),
    ...("exports" in parsed ? { exports: parsed.exports } : {}),
    ...(typeof parsed.main === "string" ? { main: parsed.main } : {}),
    ...(typeof parsed.types === "string" ? { types: parsed.types } : {}),
  };
};

export const createWorkspaceManifestReader = (
  rootInput: string,
  manifestFiles: () => Promise<ReadonlyArray<string>>,
): WorkspaceManifestReader => {
  const root = resolve(rootInput);
  let cached: Promise<ReadonlyArray<WorkspaceManifest>> | undefined;
  return {
    manifests() {
      cached ??= (async () => {
        const manifests = await Promise.all((await manifestFiles()).map((file) => readManifest(root, file)));
        return manifests
          .filter((manifest): manifest is WorkspaceManifest => manifest !== undefined)
          .sort((left, right) => left.relativeRoot.localeCompare(right.relativeRoot));
      })();
      return cached;
    },
  };
};
