/**
 * `CommandRegistry` Live Layer.
 *
 * At bootstrap level `tooling` and above, the registry exposes parsed
 * Landofile `tooling.<name>` entries as `RegisteredCommand`s. Per §8.7
 * router bootstrap omits app tooling commands when the Landofile is
 * missing or fails to parse rather than re-raising — the registry
 * therefore swallows discovery errors and returns an empty list.
 *
 * Canonical id derivation matches §8.1.1 / §8.5.1: tooling tasks default
 * to the `app:` namespace, so `tooling.<name>` registers as `app:<name>`.
 * Top-level alias, sub-namespacing, and OCLIF command registration are
 * deferred (PRD-03 US-020).
 */
import { Effect, Layer } from "effect";

import type { LandofileShape, ToolingTaskShape } from "@lando/sdk/schema";
import { CommandRegistry, LandofileService, type RegisteredCommand } from "@lando/sdk/services";

const summaryFor = (task: ToolingTaskShape): string => task.description ?? task.summary ?? "";

const toRegisteredCommands = (landofile: LandofileShape): ReadonlyArray<RegisteredCommand> => {
  const tooling = landofile.tooling;
  if (tooling === undefined) return [];
  return Object.entries(tooling).map(([name, task]) => ({
    id: `app:${name}`,
    summary: summaryFor(task),
    hidden: false,
  }));
};

export const CommandRegistryLive = Layer.effect(
  CommandRegistry,
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    return {
      list: landofileService.discover.pipe(
        Effect.map(toRegisteredCommands),
        Effect.catchAllCause(() => Effect.succeed([] as ReadonlyArray<RegisteredCommand>)),
      ),
    };
  }),
);
