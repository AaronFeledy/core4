import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import { CacheError } from "@lando/sdk/errors";
import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";

import { findLandofilePath } from "../landofile/discovery.ts";
import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";
import { CORE_VERSION } from "../version.ts";
import { writeFileAtomicViaRename } from "./atomic.ts";
import { compilePluginCommands } from "./command-compiler.ts";
import {
  type AppCommandIndexPayload,
  type CommandIndexEntry,
  type PluginCommandIndexPayload,
  decodeAppCommandIndex,
  decodePluginCommandIndex,
  deriveAppCommandEntriesFingerprint,
  deriveAppCommandToolingFingerprint,
  derivePluginCommandManifestFingerprint,
  encodeAppCommandIndex,
  encodePluginCommandIndex,
} from "./command-index.ts";
import {
  appCommandCachePath,
  appToolingCompilationCachePath,
  pluginCommandCachePath,
  resolveUserCacheRoot,
} from "./paths.ts";

const isMissingFile = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT";

export interface WriteAppCommandCacheOptions {
  readonly landofile: LandofileShape;
  readonly entries: ReadonlyArray<CommandIndexEntry>;
  readonly cwd?: string;
  readonly cacheRoot?: string;
  readonly now?: () => number;
}

interface AppCommandCacheSource {
  readonly filePath: string;
  readonly stats: {
    readonly mtimeMs: number;
    readonly size: number;
  };
  readonly contentHash?: string;
}

const readOptionalFile = async (path: string): Promise<Uint8Array | null> => {
  try {
    return await readFile(path);
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

const sourceHashFor = (landofileBytes: Uint8Array, includeLockfileBytes: Uint8Array | null): string => {
  const hash = createHash("sha256");
  hash.update(landofileBytes);
  if (includeLockfileBytes !== null) hash.update(includeLockfileBytes);
  return hash.digest("hex");
};

const resolveAppCommandCacheSource = async (cwd: string): Promise<AppCommandCacheSource | undefined> => {
  const filePath = await findLandofilePath(cwd);
  if (filePath === undefined) return undefined;

  const appRoot = dirname(filePath);
  const [stats, bytes, includeLockfileBytes] = await Promise.all([
    stat(filePath),
    readFile(filePath),
    readOptionalFile(join(appRoot, ".lando.lock.yml")),
  ]);
  return { filePath, stats, contentHash: sourceHashFor(bytes, includeLockfileBytes) };
};

const writeAppCommandCacheTask = async (
  options: WriteAppCommandCacheOptions,
): Promise<string | undefined> => {
  const cwd = options.cwd ?? process.cwd();
  const source = await resolveAppCommandCacheSource(cwd);
  if (source === undefined) return undefined;

  const { filePath, stats } = source;
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const appName = options.landofile.name ?? "unnamed";
  const appRoot = dirname(filePath);
  const cachePath = appCommandCachePath(cacheRoot, appName, appRoot);
  const toolingCompilationCachePath = appToolingCompilationCachePath(cacheRoot, appRoot);
  const toolingFingerprint = deriveAppCommandToolingFingerprint(options.landofile);
  const entriesFingerprint = deriveAppCommandEntriesFingerprint(options.entries);

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
      ...(source.contentHash === undefined ? {} : { sourceContentHash: source.contentHash }),
      sourceMtimeMs: stats.mtimeMs,
      sourceSize: stats.size,
      toolingFingerprint,
      entriesFingerprint,
    };
    await writeFileAtomicViaRename(toolingCompilationCachePath, encodeAppCommandIndex(payload));
    return cachePath;
  }

  const payload: AppCommandIndexPayload = {
    schemaVersion: 1,
    landoVersion: CORE_VERSION,
    appName,
    sourceFile: filePath,
    ...(source.contentHash === undefined ? {} : { sourceContentHash: source.contentHash }),
    sourceMtimeMs: stats.mtimeMs,
    sourceSize: stats.size,
    toolingFingerprint,
    entriesFingerprint,
    generatedAtMs: (options.now ?? Date.now)(),
    entries: options.entries,
  };

  await writeFileAtomicViaRename(cachePath, encodeAppCommandIndex(payload));
  await writeFileAtomicViaRename(toolingCompilationCachePath, encodeAppCommandIndex(payload));
  return cachePath;
};

export const writeAppCommandCache = (
  options: WriteAppCommandCacheOptions,
): Effect.Effect<string | undefined, never> =>
  writeAppCommandCacheStrict(options).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export interface WritePluginCommandCacheOptions {
  readonly manifests?: ReadonlyArray<PluginManifest>;
  readonly pluginNames?: ReadonlyArray<string>;
  readonly cacheRoot?: string;
  readonly now?: () => number;
}

const missingPluginNames = (
  manifests: ReadonlyArray<PluginManifest>,
  pluginNames: ReadonlyArray<string>,
): ReadonlyArray<string> => {
  const present = manifests.map((manifest) => String(manifest.name));
  return pluginNames.filter((name) => !present.includes(name));
};

const writePluginCommandCacheTask = async (options: WritePluginCommandCacheOptions): Promise<string> => {
  const manifests = options.manifests ?? BUNDLED_PLUGINS.map((plugin) => plugin.manifest);
  const pluginNames = options.pluginNames ?? manifests.map((manifest) => manifest.name);
  const missing = missingPluginNames(manifests, pluginNames);
  if (missing.length > 0) {
    throw new CacheError({
      message: `Cannot write plugin-command cache because bundled plugin manifests are missing: ${missing.join(", ")}.`,
      key: "plugin-command",
      cause: { missing },
    });
  }

  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const cachePath = pluginCommandCachePath(cacheRoot);
  const manifestFingerprint = derivePluginCommandManifestFingerprint(manifests);

  const cached = await readPluginCommandCacheTask({ ...options, cacheRoot, manifestFingerprint });
  if (cached !== null) return cachePath;

  const payload: PluginCommandIndexPayload = {
    schemaVersion: 1,
    landoVersion: CORE_VERSION,
    pluginNames,
    manifestFingerprint,
    generatedAtMs: (options.now ?? Date.now)(),
    entries: compilePluginCommands(manifests),
  };

  await writeFileAtomicViaRename(cachePath, encodePluginCommandIndex(payload));
  return cachePath;
};

interface ReadAppCommandCacheTaskOptions extends WriteAppCommandCacheOptions {
  readonly toolingFingerprint?: string;
  readonly entriesFingerprint?: string;
  readonly source?: AppCommandCacheSource;
}

const readAppCommandCacheTask = async (
  options: ReadAppCommandCacheTaskOptions,
): Promise<AppCommandIndexPayload | null> => {
  const cwd = options.cwd ?? process.cwd();
  const source = options.source ?? (await resolveAppCommandCacheSource(cwd));
  if (source === undefined) return null;

  const { filePath, stats } = source;
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const appName = options.landofile.name ?? "unnamed";
  const appRoot = dirname(filePath);
  const cachePath = appCommandCachePath(cacheRoot, appName, appRoot);

  try {
    const payload = decodeAppCommandIndex(new Uint8Array(await readFile(cachePath)));
    if (payload === null) return null;
    if (payload.landoVersion !== CORE_VERSION) return null;
    if (payload.sourceFile !== filePath) return null;
    if (payload.sourceContentHash !== undefined && payload.sourceContentHash !== source.contentHash)
      return null;
    if (payload.sourceMtimeMs !== stats.mtimeMs || payload.sourceSize !== stats.size) return null;
    if (
      payload.toolingFingerprint !==
      (options.toolingFingerprint ?? deriveAppCommandToolingFingerprint(options.landofile))
    ) {
      return null;
    }
    if (
      (payload.entriesFingerprint ?? deriveAppCommandEntriesFingerprint(payload.entries)) !==
      (options.entriesFingerprint ?? deriveAppCommandEntriesFingerprint(options.entries))
    ) {
      return null;
    }
    return payload;
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

const readFreshAppCommandCacheForCwdTask = async (options: {
  readonly cwd?: string;
  readonly cacheRoot?: string;
}): Promise<AppCommandIndexPayload | null> => {
  const cwd = options.cwd ?? process.cwd();
  const source = await resolveAppCommandCacheSource(cwd);
  if (source === undefined) return null;
  const appRoot = dirname(source.filePath);
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const cachePath = appToolingCompilationCachePath(cacheRoot, appRoot);

  try {
    const payload = decodeAppCommandIndex(new Uint8Array(await readFile(cachePath)));
    if (payload === null) return null;
    if (payload.landoVersion !== CORE_VERSION) return null;
    if (payload.sourceFile !== source.filePath) return null;
    if (payload.sourceContentHash !== source.contentHash) return null;
    if (payload.sourceMtimeMs !== source.stats.mtimeMs || payload.sourceSize !== source.stats.size)
      return null;
    return payload;
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

interface ReadPluginCommandCacheTaskOptions extends WritePluginCommandCacheOptions {
  readonly manifestFingerprint?: string;
}

const readPluginCommandCacheTask = async (
  options: ReadPluginCommandCacheTaskOptions = {},
): Promise<PluginCommandIndexPayload | null> => {
  const manifests = options.manifests ?? BUNDLED_PLUGINS.map((plugin) => plugin.manifest);
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const cachePath = pluginCommandCachePath(cacheRoot);

  try {
    const payload = decodePluginCommandIndex(new Uint8Array(await readFile(cachePath)));
    if (payload === null) return null;
    if (payload.landoVersion !== CORE_VERSION) return null;
    if (
      payload.manifestFingerprint !==
      (options.manifestFingerprint ?? derivePluginCommandManifestFingerprint(manifests))
    ) {
      return null;
    }
    return payload;
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

export const readAppCommandCache = (
  options: WriteAppCommandCacheOptions,
): Effect.Effect<AppCommandIndexPayload | null, CacheError> =>
  Effect.tryPromise({
    try: () => readAppCommandCacheTask(options),
    catch: (cause) =>
      new CacheError({
        message: "Failed to read app-command cache.",
        key: "app-command",
        cause,
      }),
  });

export const readFreshAppCommandCacheForCwd = (
  options: {
    readonly cwd?: string;
    readonly cacheRoot?: string;
  } = {},
): Effect.Effect<AppCommandIndexPayload | null, CacheError> =>
  Effect.tryPromise({
    try: () => readFreshAppCommandCacheForCwdTask(options),
    catch: (cause) =>
      new CacheError({
        message: "Failed to read app-command cache.",
        key: "app-command",
        cause,
      }),
  });

export const writeAppCommandCacheStrict = (
  options: WriteAppCommandCacheOptions,
): Effect.Effect<string | undefined, CacheError> =>
  Effect.tryPromise({
    try: () => writeAppCommandCacheTask(options),
    catch: (cause) =>
      cause instanceof CacheError
        ? cause
        : new CacheError({
            message: "Failed to write app-command cache.",
            key: "app-command",
            cause,
          }),
  });

export const readPluginCommandCache = (
  options: WritePluginCommandCacheOptions = {},
): Effect.Effect<PluginCommandIndexPayload | null, CacheError> =>
  Effect.tryPromise({
    try: () => readPluginCommandCacheTask(options),
    catch: (cause) =>
      new CacheError({
        message: "Failed to read plugin-command cache.",
        key: "plugin-command",
        cause,
      }),
  });

export const writePluginCommandCacheStrict = (
  options: WritePluginCommandCacheOptions = {},
): Effect.Effect<string, CacheError> =>
  Effect.tryPromise({
    try: () => writePluginCommandCacheTask(options),
    catch: (cause) =>
      cause instanceof CacheError
        ? cause
        : new CacheError({
            message: "Failed to write plugin-command cache.",
            key: "plugin-command",
            cause,
          }),
  });

export const writePluginCommandCache = (
  options: WritePluginCommandCacheOptions = {},
): Effect.Effect<string | undefined, never> =>
  writePluginCommandCacheStrict(options).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
