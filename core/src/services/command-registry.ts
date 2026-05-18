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
 *
 * On the cold path (the first `list` call), this layer also writes the
 * §12.1 plugin and app command index caches via the §12.2 binary
 * encoding. Cache writes are best-effort: a write failure never affects
 * the returned `RegisteredCommand[]`. Hot-path reads of these caches
 * are deferred past Alpha.
 */
import { Effect, Layer } from "effect";

import type { LandofileShape } from "@lando/sdk/schema";
import { CommandRegistry, LandofileService, type RegisteredCommand } from "@lando/sdk/services";

import { compileToolingCommands } from "../cache/command-compiler.ts";
import { writeAppCommandCache, writePluginCommandCache } from "../cache/command-index-writer.ts";

const toRegisteredCommands = (landofile: LandofileShape): ReadonlyArray<RegisteredCommand> =>
  compileToolingCommands(landofile).map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    hidden: entry.hidden,
  }));

const writeCachesForLandofile = (landofile: LandofileShape): Effect.Effect<void, never> =>
  Effect.all([writeAppCommandCache({ landofile }), writePluginCommandCache()], {
    concurrency: 2,
    discard: true,
  });

export const CommandRegistryLive = Layer.effect(
  CommandRegistry,
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    return {
      list: landofileService.discover.pipe(
        Effect.tap((landofile) => writeCachesForLandofile(landofile)),
        Effect.map(toRegisteredCommands),
        Effect.catchAllCause(() =>
          writePluginCommandCache().pipe(Effect.as([] as ReadonlyArray<RegisteredCommand>)),
        ),
      ),
    };
  }),
);
