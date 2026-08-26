import { Data, Effect, Schema } from "effect";

import {
  type ConfigError,
  type LandoCommandError,
  NotImplementedError,
  PluginManifestError,
} from "@lando/sdk/errors";
import { ConfigService } from "@lando/sdk/services";

import { invalidatePluginCommandCache } from "@lando/engine/cache/command-index-writer";
import { isPluginUnlinkNotLinkedCause, revertPluginLink } from "@lando/engine/operations/plugin-link";
import { makeLandoPaths } from "@lando/paths";

export class PluginUnlinkNotLinkedError extends Data.TaggedError("PluginUnlinkNotLinkedError")<{
  readonly message: string;
  readonly commandId: "meta:plugin:unlink";
  readonly pluginName: string;
  readonly remediation: string;
}> {}

export interface PluginUnlinkOptions {
  readonly name: string;
  readonly userDataRoot?: string;
  readonly pluginsRoot?: string;
  readonly cacheRoot?: string;
}

export interface PluginUnlinkResult {
  readonly pluginName: string;
  readonly registryEntry: string;
  readonly action: "restored" | "removed";
  readonly restoredPath?: string;
}

export const PluginUnlinkResultSchema = Schema.Struct({
  pluginName: Schema.String,
  registryEntry: Schema.String,
  action: Schema.Literal("restored", "removed"),
  restoredPath: Schema.optional(Schema.String),
});

const notLinkedRemediation =
  "Only locally linked plugins can be unlinked. Use `lando plugin:remove <name>` to remove an installed plugin.";

export const pluginUnlink = (
  options: PluginUnlinkOptions,
): Effect.Effect<
  PluginUnlinkResult,
  ConfigError | LandoCommandError | NotImplementedError | PluginManifestError | PluginUnlinkNotLinkedError,
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
            commandId: "meta:plugin:unlink",
            remediation: "Configure userDataRoot in <userConfRoot>/config.yml.",
          }),
        );
      }
    }
    const pluginsRoot = options.pluginsRoot ?? makeLandoPaths({ userDataRoot }).pluginsDir;
    const pluginName = options.name;

    const result = yield* Effect.tryPromise({
      try: async (): Promise<PluginUnlinkResult> => {
        const reverted = await revertPluginLink({ pluginsRoot, name: pluginName });
        return {
          pluginName,
          registryEntry: reverted.registryEntry,
          action: reverted.action,
          ...(reverted.restoredPath === undefined ? {} : { restoredPath: reverted.restoredPath }),
        };
      },
      catch: (cause) => {
        if (cause instanceof PluginUnlinkNotLinkedError || cause instanceof PluginManifestError) return cause;
        if (isPluginUnlinkNotLinkedCause(cause)) {
          return new PluginUnlinkNotLinkedError({
            message: cause.message,
            commandId: "meta:plugin:unlink",
            pluginName: cause.pluginName,
            remediation: notLinkedRemediation,
          });
        }
        return new NotImplementedError({
          message: `Plugin unlink failed for ${pluginName}: ${String(cause)}`,
          commandId: "meta:plugin:unlink",
          remediation: "Check the linked plugin state under <userDataRoot>/plugins and retry.",
        });
      },
    });

    yield* invalidatePluginCommandCache({
      ...(options.cacheRoot === undefined ? {} : { cacheRoot: options.cacheRoot }),
    });
    return result;
  });

export const renderPluginUnlinkResult = (result: PluginUnlinkResult): string =>
  [
    `plugin-unlink: ${result.pluginName}`,
    `registry-entry: ${result.registryEntry}`,
    ...(result.restoredPath === undefined ? [] : [`restored-path: ${result.restoredPath}`]),
    `result: ${result.action}`,
  ].join("\n");
