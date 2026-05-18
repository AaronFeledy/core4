/**
 * `CommandRegistry` Live Layer.
 *
 * At bootstrap level `tooling` and above, the registry exposes parsed
 * Landofile `tooling.<name>` entries and auto-discovered
 * `.lando/scripts/<name>.bun.sh` script-backed tasks (§8.5.9) as
 * `RegisteredCommand`s. Per §8.7 router bootstrap omits app tooling
 * commands when the Landofile is missing or fails to parse rather than
 * re-raising — the registry therefore swallows discovery errors and
 * returns an empty list. The same swallow-on-error contract applies to
 * `.bun.sh` discovery errors so router-time listing stays best-effort;
 * malformed script-backed tasks surface at invocation time.
 *
 * Canonical id derivation matches §8.1.1 / §8.5.1: tooling tasks default
 * to the `app:` namespace, so `tooling.<name>` registers as `app:<name>`.
 * `.lando/scripts/db/wait.bun.sh` registers as `app:db:wait`. A
 * `tooling.<id>:` entry of the same canonical id wins over an
 * auto-discovered script per §8.5.9.
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

import { compileAppCommands } from "../cache/command-compiler.ts";
import { writeAppCommandCache, writePluginCommandCache } from "../cache/command-index-writer.ts";
import { type DiscoveredBunShellScript, discoverBunShellScripts } from "../landofile/bun-sh-discovery.ts";
import { findAppRoot } from "../landofile/discovery.ts";

const discoverScriptsForCwd = (cwd: string): Effect.Effect<ReadonlyArray<DiscoveredBunShellScript>, never> =>
  Effect.gen(function* () {
    const appRoot = yield* Effect.promise(() => findAppRoot(cwd));
    if (appRoot === undefined) return [] as ReadonlyArray<DiscoveredBunShellScript>;
    return yield* discoverBunShellScripts({ appRoot }).pipe(
      Effect.catchAll(() => Effect.succeed([] as ReadonlyArray<DiscoveredBunShellScript>)),
    );
  });

const toRegisteredCommands = (
  landofile: LandofileShape,
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
): ReadonlyArray<RegisteredCommand> =>
  compileAppCommands(landofile, scripts).map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    hidden: entry.hidden,
  }));

const writeCachesForLandofile = (
  landofile: LandofileShape,
  scripts: ReadonlyArray<DiscoveredBunShellScript>,
): Effect.Effect<void, never> =>
  Effect.all([writeAppCommandCache({ landofile, scripts }), writePluginCommandCache()], {
    concurrency: 2,
    discard: true,
  });

export const CommandRegistryLive = Layer.effect(
  CommandRegistry,
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    return {
      list: Effect.gen(function* () {
        const landofile = yield* landofileService.discover;
        const scripts = yield* discoverScriptsForCwd(process.cwd());
        yield* writeCachesForLandofile(landofile, scripts);
        return toRegisteredCommands(landofile, scripts);
      }).pipe(
        Effect.catchAllCause(() =>
          writePluginCommandCache().pipe(Effect.as([] as ReadonlyArray<RegisteredCommand>)),
        ),
      ),
    };
  }),
);
