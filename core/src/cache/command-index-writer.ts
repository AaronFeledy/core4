import { mkdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { Effect } from "effect";

import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";

import { BUNDLED_PLUGINS } from "../plugins/bundled.ts";
import { CORE_VERSION } from "../version.ts";
import { compilePluginCommands, compileToolingCommands } from "./command-compiler.ts";
import {
  type AppCommandIndexPayload,
  type PluginCommandIndexPayload,
  encodeAppCommandIndex,
  encodePluginCommandIndex,
} from "./command-index.ts";
import { appCommandCachePath, pluginCommandCachePath, resolveUserCacheRoot } from "./paths.ts";

const LANDOFILE_NAME = ".lando.yml";

const removeIfPresent = async (path: string): Promise<void> => {
  await unlink(path).catch(() => undefined);
};

const writeAtomic = async (path: string, bytes: Uint8Array): Promise<void> => {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    await writeFile(tempPath, bytes);
    await rename(tempPath, path);
  } catch (cause) {
    await removeIfPresent(tempPath);
    throw cause;
  }
};

const statIfFile = async (path: string): Promise<boolean> => {
  const s = await stat(path).catch(() => undefined);
  return s?.isFile() === true;
};

const findLandofilePath = async (cwd: string): Promise<string | undefined> => {
  let current = cwd;
  for (;;) {
    const candidate = join(current, LANDOFILE_NAME);
    if (await statIfFile(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
};

export interface WriteAppCommandCacheOptions {
  readonly landofile: LandofileShape;
  readonly cwd?: string;
  readonly cacheRoot?: string;
  readonly now?: () => number;
}

const writeAppCommandCacheTask = async (
  options: WriteAppCommandCacheOptions,
): Promise<string | undefined> => {
  const cwd = options.cwd ?? process.cwd();
  const filePath = await findLandofilePath(cwd);
  if (filePath === undefined) return undefined;

  const stats = await stat(filePath);
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const appName = options.landofile.name ?? "unnamed";
  const cachePath = appCommandCachePath(cacheRoot, appName);

  const payload: AppCommandIndexPayload = {
    schemaVersion: 1,
    landoVersion: CORE_VERSION,
    appName,
    sourceFile: filePath,
    sourceMtimeMs: stats.mtimeMs,
    sourceSize: stats.size,
    generatedAtMs: (options.now ?? Date.now)(),
    entries: compileToolingCommands(options.landofile),
  };

  await writeAtomic(cachePath, encodeAppCommandIndex(payload));
  return cachePath;
};

export const writeAppCommandCache = (
  options: WriteAppCommandCacheOptions,
): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({
    try: () => writeAppCommandCacheTask(options),
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));

export interface WritePluginCommandCacheOptions {
  readonly manifests?: ReadonlyArray<PluginManifest>;
  readonly pluginNames?: ReadonlyArray<string>;
  readonly cacheRoot?: string;
  readonly now?: () => number;
}

const writePluginCommandCacheTask = async (options: WritePluginCommandCacheOptions): Promise<string> => {
  const manifests = options.manifests ?? BUNDLED_PLUGINS.map((plugin) => plugin.manifest);
  const cacheRoot = options.cacheRoot ?? resolveUserCacheRoot();
  const cachePath = pluginCommandCachePath(cacheRoot);

  const payload: PluginCommandIndexPayload = {
    schemaVersion: 1,
    landoVersion: CORE_VERSION,
    pluginNames: options.pluginNames ?? manifests.map((manifest) => manifest.name),
    generatedAtMs: (options.now ?? Date.now)(),
    entries: compilePluginCommands(manifests),
  };

  await writeAtomic(cachePath, encodePluginCommandIndex(payload));
  return cachePath;
};

export const writePluginCommandCache = (
  options: WritePluginCommandCacheOptions = {},
): Effect.Effect<string | undefined, never> =>
  Effect.tryPromise({
    try: () => writePluginCommandCacheTask(options),
    catch: (cause) => cause,
  }).pipe(Effect.catchAll(() => Effect.succeed(undefined)));
