import { existsSync } from "node:fs";
import { lstat, mkdir, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import { Data, Effect } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { invalidatePluginCommandCache } from "../../cache/command-index-writer.ts";
import { recordInstalledPlugin } from "../../plugins/installed-registry.ts";
import { validatePluginManifest } from "./plugin-add.ts";

export class PluginLinkConflictError extends Data.TaggedError("PluginLinkConflictError")<{
  readonly message: string;
  readonly commandId: "meta:plugin:link";
  readonly pluginName: string;
  readonly existingPath: string;
  readonly remediation: string;
}> {}

export interface PluginLinkOptions {
  readonly path?: string;
  readonly cwd?: string;
  readonly userDataRoot?: string;
  readonly pluginsRoot?: string;
  readonly cacheRoot?: string;
}

export interface PluginLinkResult {
  readonly pluginName: string;
  readonly linkedPath: string;
  readonly registryEntry: string;
}

type LinkedPluginState = Record<
  string,
  {
    readonly source: "linked";
    readonly linkedPath: string;
    readonly registryEntry: string;
  }
>;

const linkedStatePath = (pluginsRoot: string): string => join(pluginsRoot, ".lando-linked.json");

const readLinkedState = async (pluginsRoot: string): Promise<LinkedPluginState> => {
  const path = linkedStatePath(pluginsRoot);
  if (!existsSync(path)) return {};
  const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as LinkedPluginState;
};

const writeLinkedState = async (pluginsRoot: string, state: LinkedPluginState): Promise<void> => {
  const path = linkedStatePath(pluginsRoot);
  await mkdir(dirname(path), { recursive: true });
  const tmpPath = `${path}.tmp`;
  await writeFile(tmpPath, `${JSON.stringify(state, null, 2)}\n`);
  await rm(path, { force: true });
  await rename(tmpPath, path);
};

const loadRegistryEntry = async (
  pluginsRoot: string,
  pluginName: string,
): Promise<{ readonly source?: string; readonly path?: string } | undefined> => {
  const registryPath = join(pluginsRoot, "registry.json");
  if (!existsSync(registryPath)) return undefined;
  const parsed = JSON.parse(await readFile(registryPath, "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
  const entry = (parsed as Record<string, unknown>)[pluginName];
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return undefined;
  const record = entry as Record<string, unknown>;
  return {
    ...(typeof record.source === "string" ? { source: record.source } : {}),
    ...(typeof record.path === "string" ? { path: record.path } : {}),
  };
};

const conflictError = (pluginName: string, existingPath: string): PluginLinkConflictError =>
  new PluginLinkConflictError({
    message: `Plugin ${pluginName} already exists at ${existingPath}; refusing to replace a non-linked registry entry.`,
    commandId: "meta:plugin:link",
    pluginName,
    existingPath,
    remediation:
      "Remove or unlink the existing plugin entry before linking this local authoring checkout. Automatic replacement is deferred to unlink/restore support.",
  });

const assertInsidePluginsRoot = (pluginsRoot: string, target: string, pluginName: string): void => {
  const rel = relative(pluginsRoot, target);
  if (rel === "" || rel.startsWith("..") || resolve(pluginsRoot, rel) !== target) {
    throw new PluginManifestError({
      message: `Plugin ${pluginName} link target resolves outside ${pluginsRoot}.`,
      pluginName,
      issues: [`refusing to write ${target}`],
    });
  }
};

const prepareRegistryEntry = async (
  pluginsRoot: string,
  pluginName: string,
  registryEntry: string,
): Promise<void> => {
  assertInsidePluginsRoot(pluginsRoot, registryEntry, pluginName);
  const registry = await loadRegistryEntry(pluginsRoot, pluginName);
  const linkedState = await readLinkedState(pluginsRoot);
  const existingLinked = registry?.source === "linked" || linkedState[pluginName]?.source === "linked";
  if (existsSync(registryEntry)) {
    const stats = await lstat(registryEntry);
    if (!stats.isSymbolicLink()) throw conflictError(pluginName, registryEntry);
    if (!existingLinked) throw conflictError(pluginName, registryEntry);
    await rm(registryEntry, { force: true });
    return;
  }
  if (registry !== undefined && !existingLinked)
    throw conflictError(pluginName, registry.path ?? registryEntry);
};

export const pluginLink = (
  options: PluginLinkOptions = {},
): Effect.Effect<
  PluginLinkResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError | PluginLinkConflictError,
  ConfigService
> =>
  Effect.gen(function* () {
    let userDataRoot = options.userDataRoot;
    if (userDataRoot === undefined) {
      const configService = yield* ConfigService;
      userDataRoot = yield* configService.get("userDataRoot");
      if (userDataRoot === undefined) {
        return yield* Effect.fail(
          new NotImplementedError({
            message: "userDataRoot is not configured.",
            commandId: "meta:plugin:link",
            remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
          }),
        );
      }
    }
    const cwd = options.cwd ?? process.cwd();
    const linkedPath = resolve(cwd, options.path ?? ".");
    const pluginsRoot = options.pluginsRoot ?? join(userDataRoot, "plugins");
    const { manifest } = yield* Effect.tryPromise({
      try: () => validatePluginManifest(linkedPath),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Plugin manifest validation failed in ${linkedPath}.`,
              issues: [String(cause)],
            }),
    });
    const registryEntry = resolve(pluginsRoot, manifest.name);
    // Refuse before any filesystem mutation if the manifest name resolves
    // outside the plugins root (PluginName is an unvalidated branded string,
    // so a hostile package.json could otherwise cause `mkdir` to create
    // parent directories outside <userDataRoot>/plugins/ before the
    // collision/containment check inside `prepareRegistryEntry` fires).
    yield* Effect.try({
      try: () => assertInsidePluginsRoot(pluginsRoot, registryEntry, manifest.name),
      catch: (cause) =>
        cause instanceof PluginManifestError
          ? cause
          : new PluginManifestError({
              message: `Plugin ${manifest.name} link target resolves outside ${pluginsRoot}.`,
              pluginName: manifest.name,
              issues: [String(cause)],
            }),
    });

    yield* Effect.tryPromise({
      try: async () => {
        await mkdir(dirname(registryEntry), { recursive: true });
        await prepareRegistryEntry(pluginsRoot, manifest.name, registryEntry);
        await symlink(linkedPath, registryEntry, "dir");
        await recordInstalledPlugin(pluginsRoot, {
          name: manifest.name,
          version: manifest.version,
          path: registryEntry,
          source: "linked",
          linkedPath,
        });
        const state = await readLinkedState(pluginsRoot);
        await writeLinkedState(pluginsRoot, {
          ...state,
          [manifest.name]: { source: "linked", linkedPath, registryEntry },
        });
      },
      catch: (cause) =>
        cause instanceof PluginLinkConflictError || cause instanceof PluginManifestError
          ? cause
          : new NotImplementedError({
              message: `Plugin link failed for ${manifest.name}: ${String(cause)}`,
              commandId: "meta:plugin:link",
              remediation: "Check the plugin authoring path and retry.",
            }),
    });

    yield* invalidatePluginCommandCache({
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    return { pluginName: manifest.name, linkedPath, registryEntry };
  });

export const renderPluginLinkResult = (result: PluginLinkResult): string =>
  [
    `plugin-link: ${result.pluginName}`,
    `linked-path: ${result.linkedPath}`,
    `registry-entry: ${result.registryEntry}`,
    "result: linked",
  ].join("\n");
