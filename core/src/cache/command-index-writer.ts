import { createHash } from "node:crypto";
import { readFile, readdir, realpath, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import { Effect } from "effect";

import { CacheError } from "@lando/sdk/errors";
import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";

import {
  type VersionConstraintEntry,
  evaluateVersionConstraints,
  getVersionConstraintEntries,
  hasSkippedUnsatisfiedVersionConstraint,
  isVersionConstraintEntryArray,
  isVersionConstraintSkipped,
} from "../config/version-constraint.ts";
import { findLandofilePath } from "../landofile/discovery.ts";
import { getLocalIncludePaths } from "../landofile/include-provenance.ts";
import { presentLandofileLayers } from "../landofile/layers.ts";
import { detectTemplateDirective } from "../landofile/template-render.ts";
import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";
import { CORE_VERSION } from "../version.ts";
import { writeFileAtomicViaRename } from "./atomic.ts";
import { compilePluginCommands } from "./command-compiler.ts";
import {
  type AppCommandIndexPayload,
  COMMAND_INDEX_SCHEMA_VERSION,
  type CommandIndexEntry,
  type PluginCommandIndexPayload,
  decodeAppCommandIndex,
  decodePluginCommandIndex,
  deriveAppCommandEntriesFingerprint,
  deriveAppCommandToolingFingerprint,
  derivePluginCommandIdsByPlugin,
  derivePluginCommandManifestFingerprint,
  derivePluginCommandPluginListSha,
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

const versionConstraintsEqual = (
  left: ReadonlyArray<VersionConstraintEntry> | undefined,
  right: ReadonlyArray<VersionConstraintEntry>,
): boolean => JSON.stringify(left) === JSON.stringify(right);

const versionConstraintsUsable = (entries: ReadonlyArray<VersionConstraintEntry> | undefined): boolean => {
  if (!isVersionConstraintEntryArray(entries)) return false;
  const evaluation = evaluateVersionConstraints(entries, CORE_VERSION);
  if (evaluation.invalid.length > 0) return false;
  return evaluation.unsatisfied.length === 0 || isVersionConstraintSkipped(process.env);
};

const BUN_SHELL_SCRIPT_EXTENSION = ".bun.sh";
const SCRIPTS_DIRNAME = join(".lando", "scripts");

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
  readonly landofileSources: ReadonlyArray<{ readonly relativePath: string; readonly bytes: Uint8Array }>;
  readonly includeLockfileBytes: Uint8Array | null;
  readonly scripts: ReadonlyArray<BunShellScriptSource>;
}

const readOptionalFile = async (path: string): Promise<Uint8Array | null> => {
  try {
    return await readFile(path);
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

const landofileUsesTemplate = (bytes: Uint8Array): boolean =>
  detectTemplateDirective(Buffer.from(bytes).toString("utf8")) !== undefined;

interface BunShellScriptSource {
  readonly relativePath: string;
  readonly bytes: Uint8Array;
}

interface LocalIncludeSource {
  readonly relativePath: string;
  readonly bytes: Uint8Array | null;
}

const isRemoteInclude = (source: string): boolean =>
  source.startsWith("npm:") ||
  source.startsWith("git@") ||
  source.startsWith("github:") ||
  /^https?:\/\//u.test(source);

const includeEntrySource = (entry: NonNullable<LandofileShape["includes"]>[number]): string =>
  typeof entry === "string" ? entry : entry.source;

const localIncludePathsForLandofile = (landofile: LandofileShape): ReadonlyArray<string> => {
  const remembered = getLocalIncludePaths(landofile);
  if (remembered.length > 0) return remembered;
  return (landofile.includes ?? [])
    .map((entry) => includeEntrySource(entry))
    .filter((source) => !isRemoteInclude(source));
};

const pathIsUnderRoot = (root: string, path: string): boolean => {
  const relativePath = relative(root, path);
  return (
    relativePath === "" ||
    (relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
  );
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
): Promise<{ readonly filePath: string; readonly relativePath: string } | undefined> => {
  if (isRemoteInclude(source)) return undefined;
  const candidate = isAbsolute(source) ? source : resolve(appRoot, source);
  if (!pathIsUnderRoot(appRoot, candidate)) return undefined;

  const realRoot = await realpath(appRoot);
  const realCandidate = await realpathIfPresent(candidate);
  if (realCandidate === undefined) {
    return { filePath: candidate, relativePath: relative(appRoot, candidate).split(sep).join("/") };
  }
  if (!pathIsUnderRoot(realRoot, realCandidate)) {
    throw new CacheError({
      message: `Local include ${source} resolves outside the app root.`,
      key: "app-command",
      path: candidate,
    });
  }
  return { filePath: realCandidate, relativePath: relative(realRoot, realCandidate).split(sep).join("/") };
};

const localIncludeSourcesFor = async (
  appRoot: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyArray<LocalIncludeSource>> => {
  const sources: LocalIncludeSource[] = [];
  for (const source of [...new Set(paths)].sort((left, right) => left.localeCompare(right))) {
    const includePath = await localIncludePath(appRoot, source);
    if (includePath === undefined) continue;
    sources.push({
      relativePath: includePath.relativePath,
      bytes: await readOptionalFile(includePath.filePath),
    });
  }
  return sources;
};

const readBunShellScriptSources = async (appRoot: string): Promise<ReadonlyArray<BunShellScriptSource>> => {
  const scriptsRoot = join(appRoot, SCRIPTS_DIRNAME);
  const exists = await stat(scriptsRoot).catch((cause) => {
    if (isMissingFile(cause)) return undefined;
    throw cause;
  });
  if (exists?.isDirectory() !== true) return [];

  const files: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const absolutePath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(BUN_SHELL_SCRIPT_EXTENSION)) continue;
      files.push(absolutePath);
    }
  };
  await visit(scriptsRoot);

  return Promise.all(
    files.map(async (absolutePath) => ({
      relativePath: relative(scriptsRoot, absolutePath).split(sep).join("/"),
      bytes: await readFile(absolutePath),
    })),
  );
};

const sourceHashFor = (
  landofileSources: ReadonlyArray<{ readonly relativePath: string; readonly bytes: Uint8Array }>,
  includeLockfileBytes: Uint8Array | null,
  localIncludes: ReadonlyArray<LocalIncludeSource>,
  scripts: ReadonlyArray<BunShellScriptSource>,
): string => {
  const hash = createHash("sha256");
  hash.update("landofiles\0");
  for (const source of landofileSources) {
    hash.update(source.relativePath);
    hash.update("\0");
    hash.update(source.bytes);
    hash.update("\0");
  }
  hash.update("\0include-lock\0");
  if (includeLockfileBytes !== null) hash.update(includeLockfileBytes);
  hash.update("\0local-includes\0");
  for (const include of localIncludes) {
    hash.update(include.relativePath);
    hash.update("\0");
    if (include.bytes === null) hash.update("<missing>");
    else hash.update(include.bytes);
    hash.update("\0");
  }
  hash.update("\0bun-shell-scripts\0");
  for (const script of scripts) {
    hash.update(script.relativePath);
    hash.update("\0");
    hash.update(script.bytes);
    hash.update("\0");
  }
  return hash.digest("hex");
};

const resolveAppCommandCacheSource = async (cwd: string): Promise<AppCommandCacheSource | undefined> => {
  const filePath = await findLandofilePath(cwd);
  if (filePath === undefined) return undefined;

  const appRoot = dirname(filePath);
  const layers = await presentLandofileLayers(appRoot);
  const [stats, landofileSources, includeLockfileBytes, scripts] = await Promise.all([
    stat(filePath),
    Promise.all(
      layers.map(async (layer) => ({
        relativePath: relative(appRoot, layer.filePath).split(sep).join("/"),
        bytes: await readFile(layer.filePath),
      })),
    ),
    readOptionalFile(join(appRoot, ".lando.lock.yml")),
    readBunShellScriptSources(appRoot),
  ]);
  return { filePath, stats, landofileSources, includeLockfileBytes, scripts };
};

const sourceContentHash = async (
  source: AppCommandCacheSource,
  appRoot: string,
  localIncludePaths: ReadonlyArray<string>,
): Promise<string> =>
  sourceHashFor(
    source.landofileSources,
    source.includeLockfileBytes,
    await localIncludeSourcesFor(appRoot, localIncludePaths),
    source.scripts,
  );

const pathsEqual = (left: ReadonlyArray<string> | undefined, right: ReadonlyArray<string>): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

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
  const versionConstraints = getVersionConstraintEntries(options.landofile, filePath);
  if (hasSkippedUnsatisfiedVersionConstraint(versionConstraints, CORE_VERSION)) return undefined;
  const sourceLocalIncludePaths = localIncludePathsForLandofile(options.landofile);
  const contentHash = await sourceContentHash(source, appRoot, sourceLocalIncludePaths);

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
      sourceMtimeMs: stats.mtimeMs,
      sourceSize: stats.size,
      versionConstraints,
      toolingFingerprint,
      entriesFingerprint,
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
    sourceMtimeMs: stats.mtimeMs,
    sourceSize: stats.size,
    versionConstraints,
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
  const pluginListSha = derivePluginCommandPluginListSha(manifests);
  const commandsByPlugin = derivePluginCommandIdsByPlugin(manifests);

  const cached = await readPluginCommandCacheTask({ ...options, cacheRoot, manifestFingerprint });
  if (cached !== null) return cachePath;

  const payload: PluginCommandIndexPayload = {
    schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
    landoVersion: CORE_VERSION,
    pluginNames,
    manifestFingerprint,
    pluginListSha,
    commandsByPlugin,
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
    const sourceLocalIncludePaths = localIncludePathsForLandofile(options.landofile);
    if (!pathsEqual(payload.sourceLocalIncludePaths, sourceLocalIncludePaths)) return null;
    if (payload.sourceContentHash !== (await sourceContentHash(source, appRoot, sourceLocalIncludePaths)))
      return null;
    if (payload.sourceMtimeMs !== stats.mtimeMs || payload.sourceSize !== stats.size) return null;
    if (
      payload.toolingFingerprint !==
      (options.toolingFingerprint ?? deriveAppCommandToolingFingerprint(options.landofile))
    ) {
      return null;
    }
    const versionConstraints = getVersionConstraintEntries(options.landofile, filePath);
    if (!versionConstraintsEqual(payload.versionConstraints, versionConstraints)) return null;
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
  if (source.landofileSources.some((entry) => entry.relativePath.endsWith(".ts"))) return null;
  if (source.landofileSources.some((entry) => landofileUsesTemplate(entry.bytes))) return null;
  const appRoot = dirname(source.filePath);
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const cachePath = appToolingCompilationCachePath(cacheRoot, appRoot);

  try {
    const payload = decodeAppCommandIndex(new Uint8Array(await readFile(cachePath)));
    if (payload === null) return null;
    if (payload.landoVersion !== CORE_VERSION) return null;
    if (payload.sourceFile !== source.filePath) return null;
    if (!Array.isArray(payload.sourceLocalIncludePaths)) return null;
    if (
      payload.sourceContentHash !==
      (await sourceContentHash(source, appRoot, payload.sourceLocalIncludePaths))
    )
      return null;
    if (payload.sourceMtimeMs !== source.stats.mtimeMs || payload.sourceSize !== source.stats.size)
      return null;
    if (!versionConstraintsUsable(payload.versionConstraints)) return null;
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
  const pluginListSha = derivePluginCommandPluginListSha(manifests);
  const commandsByPlugin = derivePluginCommandIdsByPlugin(manifests);

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
    if (payload.pluginListSha !== pluginListSha) return null;
    if (JSON.stringify(payload.commandsByPlugin) !== JSON.stringify(commandsByPlugin)) return null;
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

export const invalidatePluginCommandCache = (
  options: { readonly cacheRoot?: string } = {},
): Effect.Effect<void, never> =>
  Effect.promise(async () => {
    const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
    await rm(pluginCommandCachePath(cacheRoot), { force: true });
  }).pipe(Effect.catchAll(() => Effect.void));
