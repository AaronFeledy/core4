import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findLandofilePath } from "@lando/landofile/discovery";
import { getLocalIncludePaths } from "@lando/landofile/include-provenance";
import { presentLandofileLayers } from "@lando/landofile/layers";
import { isPathWithin } from "@lando/paths";
import { sha256Hex } from "@lando/sdk/digest";
import { CacheError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { Effect } from "effect";

export const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "ENOENT";

export interface AppCommandCacheSource {
  readonly filePath: string;
  readonly stats: { readonly mtimeMs: number; readonly size: number };
  readonly landofileSources: ReadonlyArray<{ readonly relativePath: string; readonly bytes: Uint8Array }>;
  readonly includeLockfileBytes: Uint8Array | null;
}

const readOptionalFile = async (path: string): Promise<Uint8Array | null> => {
  try {
    return await readFile(path);
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

interface LocalIncludeSource {
  readonly relativePath: string;
  readonly bytes: Uint8Array | null;
}

const isRemoteInclude = (source: string): boolean =>
  source.startsWith("npm:") ||
  source.startsWith("git@") ||
  source.startsWith("github:") ||
  /^https?:\/\//u.test(source);

export const localIncludePathsForLandofile = (landofile: LandofileShape): ReadonlyArray<string> => {
  const remembered = getLocalIncludePaths(landofile);
  if (remembered.length > 0) return remembered;
  return (landofile.includes ?? [])
    .map((entry) => (typeof entry === "string" ? entry : entry.source))
    .filter((source) => !isRemoteInclude(source));
};

const realpathIfPresent = async (path: string): Promise<string | undefined> => {
  try {
    return await realpath(path);
  } catch (cause) {
    if (isMissingFile(cause)) return undefined;
    throw cause;
  }
};

const localIncludePath = async (
  appRoot: string,
  source: string,
  allowOutsideRoot: boolean,
): Promise<{ readonly filePath: string; readonly relativePath: string } | undefined> => {
  if (isRemoteInclude(source)) return undefined;
  const candidate = isAbsolute(source) ? source : resolve(appRoot, source);
  if (!isPathWithin(appRoot, candidate)) {
    if (!allowOutsideRoot || !isAbsolute(source)) return undefined;
    const realCandidate = await realpathIfPresent(candidate);
    return { filePath: realCandidate ?? candidate, relativePath: `external:${sha256Hex(candidate)}` };
  }
  const realRoot = await realpath(appRoot);
  const realCandidate = await realpathIfPresent(candidate);
  if (realCandidate === undefined)
    return { filePath: candidate, relativePath: relative(appRoot, candidate).split(sep).join("/") };
  if (!isPathWithin(realRoot, realCandidate)) {
    throw new CacheError({
      message: `Local include ${source} resolves outside the app root.`,
      key: "app-command",
      path: candidate,
      remediation: "Update the local include path or symlink so its target stays inside the app root.",
    });
  }
  return { filePath: realCandidate, relativePath: relative(realRoot, realCandidate).split(sep).join("/") };
};

const localIncludeSourcesFor = async (
  appRoot: string,
  paths: ReadonlyArray<string>,
  allowOutsideRoot: boolean,
): Promise<ReadonlyArray<LocalIncludeSource>> => {
  const sources: LocalIncludeSource[] = [];
  for (const source of [...new Set(paths)].sort()) {
    const includePath = await localIncludePath(appRoot, source, allowOutsideRoot);
    if (includePath === undefined) continue;
    sources.push({
      relativePath: includePath.relativePath,
      bytes: await readOptionalFile(includePath.filePath),
    });
  }
  return sources;
};

const sourceHashFor = (
  source: AppCommandCacheSource,
  localIncludes: ReadonlyArray<LocalIncludeSource>,
): string => {
  const hash = createHash("sha256");
  hash.update("landofiles\0");
  for (const layer of source.landofileSources) {
    hash.update(layer.relativePath);
    hash.update("\0");
    hash.update(layer.bytes);
    hash.update("\0");
  }
  hash.update("\0include-lock\0");
  if (source.includeLockfileBytes !== null) hash.update(source.includeLockfileBytes);
  hash.update("\0local-includes\0");
  for (const include of localIncludes) {
    hash.update(include.relativePath);
    hash.update("\0");
    if (include.bytes === null) hash.update("<missing>");
    else hash.update(include.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const resolveAppCommandCacheSource = Effect.fnUntraced(function* (cwd?: string) {
  const filePath = yield* findLandofilePath(cwd);
  if (filePath === undefined) return undefined;
  const appRoot = dirname(filePath);
  const layers = yield* presentLandofileLayers(appRoot);
  const [stats, landofileSources, includeLockfileBytes] = yield* Effect.tryPromise({
    try: () =>
      Promise.all([
        stat(filePath),
        Promise.all(
          layers.map(async (layer) => ({
            relativePath: relative(appRoot, layer.filePath).split(sep).join("/"),
            bytes: await readFile(layer.filePath),
          })),
        ),
        readOptionalFile(join(appRoot, ".lando.lock.yml")),
      ]),
    catch: (cause) =>
      new CacheError({
        message: "Failed to read app-command sources.",
        key: "app-command",
        cause,
        remediation: "Ensure the app's Landofile layers and any .lando.lock.yml file exist and are readable.",
      }),
  });
  return { filePath, stats, landofileSources, includeLockfileBytes };
});

export const sourceContentHash = async (
  source: AppCommandCacheSource,
  localIncludePaths: ReadonlyArray<string>,
  allowOutsideRoot = false,
): Promise<string> =>
  sourceHashFor(
    source,
    await localIncludeSourcesFor(dirname(source.filePath), localIncludePaths, allowOutsideRoot),
  );
