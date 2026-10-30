import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { getLocalIncludePaths } from "@lando/landofile/include-provenance";
import { getLandofileReferencedFiles } from "@lando/landofile/load-expression-provenance";
import {
  getVersionConstraintEntries,
  hasSkippedUnsatisfiedVersionConstraint,
} from "@lando/landofile/version-constraint";
import { CacheError, type LandofileFormConflictError } from "@lando/sdk/errors";
import type { LandofileShape } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { CORE_VERSION } from "../version.ts";
import { writeFileAtomicViaRename } from "./atomic.ts";
import {
  type AppCommandCacheSource,
  isMissingFile,
  localIncludePathsForLandofile,
  resolveAppCommandCacheSource,
  sourceContentHash,
} from "./command-index-source.ts";
import {
  type AppCommandIndexPayload,
  COMMAND_INDEX_SCHEMA_VERSION,
  type CommandIndexEntry,
  decodeAppCommandIndex,
  deriveAppCommandEntriesFingerprint,
  deriveAppCommandToolingFingerprint,
  encodeAppCommandIndex,
  normalizeAppCommandAliasPolicy,
} from "./command-index.ts";
import { commandScriptFingerprints } from "./command-script-freshness.ts";
import { appCommandCachePath, appToolingCompilationCachePath, resolveUserCacheRoot } from "./paths.ts";

export {
  type AppCommandCacheReadResult,
  type ReadAppCommandCacheOptions,
  readAppCommandCacheForCwdDetailed,
  readFreshAppCommandCacheForCwd,
} from "./command-index-reader.ts";
export {
  type WritePluginCommandCacheOptions,
  invalidatePluginCommandCache,
  readPluginCommandCache,
  writePluginCommandCache,
  writePluginCommandCacheStrict,
} from "./plugin-command-index.ts";

export interface WriteAppCommandCacheOptions {
  readonly landofile: LandofileShape;
  readonly entries: ReadonlyArray<CommandIndexEntry>;
  readonly cwd?: string;
  readonly cacheRoot?: string;
  readonly now?: () => number;
}

interface ReadAppCommandCacheTaskOptions extends WriteAppCommandCacheOptions {
  readonly toolingFingerprint?: string;
  readonly entriesFingerprint?: string;
  readonly source?: AppCommandCacheSource;
}

const readAppCommandCacheTask = async (
  options: ReadAppCommandCacheTaskOptions,
): Promise<AppCommandIndexPayload | null> => {
  const source = options.source;
  if (source === undefined) return null;
  const { filePath, stats } = source;
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const appName = options.landofile.name ?? "unnamed";
  const cachePath = appCommandCachePath(cacheRoot, appName, dirname(filePath));
  try {
    const payload = decodeAppCommandIndex(new Uint8Array(await readFile(cachePath)));
    if (payload === null) return null;
    if (payload.landoVersion !== CORE_VERSION) return null;
    if (payload.sourceFile !== filePath) return null;
    const sourceLocalIncludePaths = localIncludePathsForLandofile(options.landofile);
    if (JSON.stringify(payload.sourceLocalIncludePaths) !== JSON.stringify(sourceLocalIncludePaths))
      return null;
    if (
      JSON.stringify(payload.sourceReferencedFiles) !==
      JSON.stringify(getLandofileReferencedFiles(options.landofile))
    )
      return null;
    if (
      payload.sourceContentHash !==
      (await sourceContentHash(
        source,
        sourceLocalIncludePaths,
        getLocalIncludePaths(options.landofile).length > 0,
      ))
    )
      return null;
    if (payload.sourceMtimeMs !== stats.mtimeMs || payload.sourceSize !== stats.size) return null;
    if (
      payload.toolingFingerprint !==
      (options.toolingFingerprint ?? deriveAppCommandToolingFingerprint(options.landofile))
    )
      return null;
    if (
      JSON.stringify(payload.versionConstraints) !==
      JSON.stringify(getVersionConstraintEntries(options.landofile, filePath))
    )
      return null;
    if (
      (payload.entriesFingerprint ?? deriveAppCommandEntriesFingerprint(payload.entries)) !==
      (options.entriesFingerprint ?? deriveAppCommandEntriesFingerprint(options.entries))
    )
      return null;
    return payload;
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

const writeAppCommandCacheTask = async (
  options: WriteAppCommandCacheOptions,
  source: AppCommandCacheSource,
): Promise<string | undefined> => {
  const { filePath, stats } = source;
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const appName = options.landofile.name ?? "unnamed";
  const appRoot = dirname(filePath);
  const cachePath = appCommandCachePath(cacheRoot, appName, appRoot);
  const toolingCompilationCachePath = appToolingCompilationCachePath(cacheRoot, appRoot);
  const toolingFingerprint = deriveAppCommandToolingFingerprint(options.landofile);
  const entriesFingerprint = deriveAppCommandEntriesFingerprint(options.entries);
  const aliasPolicy = normalizeAppCommandAliasPolicy(options.landofile);
  const versionConstraints = getVersionConstraintEntries(options.landofile, filePath);
  if (hasSkippedUnsatisfiedVersionConstraint(versionConstraints, CORE_VERSION)) return undefined;
  const sourceLocalIncludePaths = localIncludePathsForLandofile(options.landofile);
  const sourceReferencedFiles = getLandofileReferencedFiles(options.landofile);
  const sourceScripts = await commandScriptFingerprints(appRoot);
  const contentHash = await sourceContentHash(
    source,
    sourceLocalIncludePaths,
    getLocalIncludePaths(options.landofile).length > 0,
  );
  const cached = await readAppCommandCacheTask({
    ...options,
    cacheRoot,
    toolingFingerprint,
    entriesFingerprint,
    source,
  });
  if (cached !== null) {
    const payload: AppCommandIndexPayload = {
      ...cached,
      sourceFile: filePath,
      sourceContentHash: contentHash,
      sourceLocalIncludePaths,
      sourceReferencedFiles,
      sourceScripts,
      sourceMtimeMs: stats.mtimeMs,
      sourceSize: stats.size,
      versionConstraints,
      toolingFingerprint,
      entriesFingerprint,
      ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
    };
    await writeFileAtomicViaRename(toolingCompilationCachePath, encodeAppCommandIndex(payload));
    return cachePath;
  }
  const payload: AppCommandIndexPayload = {
    schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
    landoVersion: CORE_VERSION,
    appName,
    sourceFile: filePath,
    sourceContentHash: contentHash,
    sourceLocalIncludePaths,
    sourceReferencedFiles,
    sourceScripts,
    sourceMtimeMs: stats.mtimeMs,
    sourceSize: stats.size,
    versionConstraints,
    toolingFingerprint,
    entriesFingerprint,
    ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
    generatedAtMs: options.now === undefined ? DateTime.toEpochMillis(DateTime.nowUnsafe()) : options.now(),
    entries: options.entries,
  };
  await writeFileAtomicViaRename(cachePath, encodeAppCommandIndex(payload));
  await writeFileAtomicViaRename(toolingCompilationCachePath, encodeAppCommandIndex(payload));
  return cachePath;
};

export const readAppCommandCache = (
  options: WriteAppCommandCacheOptions,
): Effect.Effect<AppCommandIndexPayload | null, CacheError | LandofileFormConflictError> =>
  resolveAppCommandCacheSource(options.cwd).pipe(
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.succeed(null)
        : Effect.tryPromise({
            try: () => readAppCommandCacheTask({ ...options, source }),
            catch: (cause) =>
              new CacheError({
                message: "Failed to read app-command cache.",
                key: "app-command",
                cause,
                remediation: "Delete the Lando cache entry `app-command` and re-run the command.",
              }),
          }),
    ),
  );

export const writeAppCommandCacheStrict = (
  options: WriteAppCommandCacheOptions,
): Effect.Effect<string | undefined, CacheError | LandofileFormConflictError> =>
  resolveAppCommandCacheSource(options.cwd).pipe(
    Effect.flatMap((source) =>
      source === undefined
        ? Effect.succeed(undefined)
        : Effect.tryPromise({
            try: () => writeAppCommandCacheTask(options, source),
            catch: (cause) =>
              cause instanceof CacheError
                ? cause
                : new CacheError({
                    message: "Failed to write app-command cache.",
                    key: "app-command",
                    cause,
                    remediation: "Delete the Lando cache entry `app-command` and re-run the command.",
                  }),
          }),
    ),
  );

export const writeAppCommandCache = (
  options: WriteAppCommandCacheOptions,
): Effect.Effect<string | undefined, never> =>
  writeAppCommandCacheStrict(options).pipe(Effect.catch(() => Effect.succeed(undefined)));
