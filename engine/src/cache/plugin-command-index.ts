import { readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { CacheError } from "@lando/sdk/errors";
import type { PluginManifest } from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { bundledPluginModules } from "../composition.ts";
import { CORE_VERSION } from "../version.ts";
import { writeFileAtomicViaRename } from "./atomic.ts";
import { compilePluginCommands } from "./command-compiler.ts";
import { isMissingFile } from "./command-index-source.ts";
import {
  COMMAND_INDEX_SCHEMA_VERSION,
  type PluginCommandIndexPayload,
  decodePluginCommandIndex,
  derivePluginCommandIdsByPlugin,
  derivePluginCommandManifestFingerprint,
  derivePluginCommandPluginListSha,
  encodePluginCommandIndex,
} from "./command-index.ts";
import { pluginCommandCachePath, resolveUserCacheRoot } from "./paths.ts";

export interface WritePluginCommandCacheOptions {
  readonly manifests?: ReadonlyArray<PluginManifest>;
  readonly modules?: ReadonlyArray<{ readonly manifest: PluginManifest }>;
  readonly pluginNames?: ReadonlyArray<string>;
  readonly cacheRoot?: string;
  readonly now?: () => number;
}

const resolvePluginManifests = (options: WritePluginCommandCacheOptions): ReadonlyArray<PluginManifest> =>
  options.manifests ?? (options.modules ?? bundledPluginModules()).map((module) => module.manifest);

interface ReadPluginCommandCacheTaskOptions extends WritePluginCommandCacheOptions {
  readonly manifestFingerprint?: string;
}

const readPluginCommandCacheTask = async (
  options: ReadPluginCommandCacheTaskOptions = {},
): Promise<PluginCommandIndexPayload | null> => {
  const manifests = resolvePluginManifests(options);
  const pluginNames = options.pluginNames ?? manifests.map((manifest) => manifest.name);
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
    )
      return null;
    if (payload.pluginListSha !== pluginListSha) return null;
    if (JSON.stringify(payload.commandsByPlugin) !== JSON.stringify(commandsByPlugin)) return null;
    if (JSON.stringify(payload.pluginNames) !== JSON.stringify(pluginNames)) return null;
    return payload;
  } catch (cause) {
    if (isMissingFile(cause)) return null;
    throw cause;
  }
};

const writePluginCommandCacheTask = async (options: WritePluginCommandCacheOptions): Promise<string> => {
  const manifests = resolvePluginManifests(options);
  const pluginNames = options.pluginNames ?? manifests.map((manifest) => manifest.name);
  const present = new Set(manifests.map((manifest) => String(manifest.name)));
  const missing = pluginNames.filter((name) => !present.has(name));
  if (missing.length > 0)
    throw new CacheError({
      message: `Cannot write plugin-command cache because bundled plugin manifests are missing: ${missing.join(", ")}.`,
      key: "plugin-command",
      cause: { missing },
      remediation: "Restore the missing bundled plugin manifests by reinstalling Lando, then retry.",
    });
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const cachePath = pluginCommandCachePath(cacheRoot);
  const manifestFingerprint = derivePluginCommandManifestFingerprint(manifests);
  const cached = await readPluginCommandCacheTask({ ...options, cacheRoot, manifestFingerprint });
  if (cached !== null) return cachePath;
  const payload: PluginCommandIndexPayload = {
    schemaVersion: Number(COMMAND_INDEX_SCHEMA_VERSION),
    landoVersion: CORE_VERSION,
    pluginNames,
    manifestFingerprint,
    pluginListSha: derivePluginCommandPluginListSha(manifests),
    commandsByPlugin: derivePluginCommandIdsByPlugin(manifests),
    generatedAtMs: options.now === undefined ? DateTime.toEpochMillis(DateTime.nowUnsafe()) : options.now(),
    entries: compilePluginCommands(manifests),
  };
  await writeFileAtomicViaRename(cachePath, encodePluginCommandIndex(payload));
  return cachePath;
};

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
        remediation: "Delete the Lando cache entry `plugin-command` and re-run the command.",
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
            remediation: "Delete the Lando cache entry `plugin-command` and re-run the command.",
          }),
  });

export const writePluginCommandCache = (
  options: WritePluginCommandCacheOptions = {},
): Effect.Effect<string | undefined, never> =>
  writePluginCommandCacheStrict(options).pipe(Effect.catch(() => Effect.succeed(undefined)));

export const invalidatePluginCommandCache = (
  options: { readonly cacheRoot?: string } = {},
): Effect.Effect<void, never> =>
  Effect.tryPromise({
    try: async () => {
      const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
      await rm(pluginCommandCachePath(cacheRoot), { force: true });
      const appsRoot = join(cacheRoot, "apps");
      const entries = await readdir(appsRoot, { withFileTypes: true }).catch((cause) => {
        if (isMissingFile(cause)) return [];
        throw cause;
      });
      await Promise.all(
        entries
          .filter((entry) => entry.isDirectory() && entry.name.startsWith("tooling-"))
          .map((entry) => rm(join(appsRoot, entry.name), { recursive: true, force: true })),
      );
    },
    catch: () => undefined,
  }).pipe(Effect.ignore);
