import { resolve } from "node:path";

import { Effect, Schema } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import type { ConfigService } from "@lando/sdk/services";

import { invalidatePluginCommandCache } from "@lando/engine/cache/command-index-writer";
import { validatePluginManifest } from "@lando/engine/operations/plugin-install";
import {
  applyPluginLink,
  assertInsidePluginsRoot,
  isPluginLinkConflictCause,
} from "@lando/engine/operations/plugin-link";
import { withPluginMutationLock } from "@lando/engine/plugins/mutation-lock";
import { resolvePluginsRoot } from "./plugin-roots";

export class PluginLinkConflictError extends Schema.TaggedError<PluginLinkConflictError>()(
  "PluginLinkConflictError",
  {
    message: Schema.String,
    commandId: Schema.Literal("meta:plugin:link"),
    pluginName: Schema.String,
    existingPath: Schema.String,
    remediation: Schema.String,
  },
) {}

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

export const PluginLinkResultSchema = Schema.Struct({
  pluginName: Schema.String,
  linkedPath: Schema.String,
  registryEntry: Schema.String,
});

const conflictRemediation =
  "Remove or unlink the existing plugin entry before linking this local authoring checkout. Automatic replacement is deferred to unlink/restore support.";

export const pluginLink = Effect.fn("PluginLink.link")(function* (
  options: PluginLinkOptions = {},
): Effect.fn.Return<
  PluginLinkResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError | PluginLinkConflictError,
  ConfigService
> {
  const pluginsRoot = yield* resolvePluginsRoot(options, "meta:plugin:link");
  const cwd = options.cwd ?? process.cwd();
  const linkedPath = resolve(cwd, options.path ?? ".");
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

  yield* withPluginMutationLock(
    pluginsRoot,
    "meta:plugin:link",
    Effect.gen(function* () {
      yield* Effect.tryPromise({
        try: () =>
          applyPluginLink({
            pluginsRoot,
            linkedPath,
            pluginName: manifest.name,
            version: manifest.version,
          }),
        catch: (cause) => {
          if (cause instanceof PluginLinkConflictError || cause instanceof PluginManifestError) return cause;
          if (isPluginLinkConflictCause(cause)) {
            return new PluginLinkConflictError({
              message: cause.message,
              commandId: "meta:plugin:link",
              pluginName: cause.pluginName,
              existingPath: cause.existingPath,
              remediation: conflictRemediation,
            });
          }
          return new NotImplementedError({
            message: `Plugin link failed for ${manifest.name}: ${String(cause)}`,
            commandId: "meta:plugin:link",
            remediation: "Check the plugin authoring path and retry.",
          });
        },
      });
      yield* invalidatePluginCommandCache({
        ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
      });
    }),
  );
  return { pluginName: manifest.name, linkedPath, registryEntry };
});

export const renderPluginLinkResult = (result: PluginLinkResult): string =>
  [
    `plugin-link: ${result.pluginName}`,
    `linked-path: ${result.linkedPath}`,
    `registry-entry: ${result.registryEntry}`,
    "result: linked",
  ].join("\n");
