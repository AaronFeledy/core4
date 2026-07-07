/**
 * `CommandRegistry` Live Layer.
 *
 * At bootstrap level `tooling` and above, the registry exposes parsed
 * Landofile `tooling.<name>` entries and auto-discovered
 * `.lando/scripts/<name>.bun.sh` script-backed tasks as
 * `RegisteredCommand`s. Router bootstrap omits app tooling commands
 * when the Landofile is missing or fails to parse rather than re-raising
 * — the registry therefore swallows discovery errors and returns an
 * empty list. The same swallow-on-error contract applies to `.bun.sh`
 * discovery errors so router-time listing stays best-effort; malformed
 * script-backed tasks surface at invocation time.
 *
 * Tooling tasks default to the `app:` namespace, so `tooling.<name>`
 * registers as `app:<name>`. `.lando/scripts/db/wait.bun.sh` registers
 * as `app:db:wait`. A `tooling.<id>:` entry of the same canonical id wins
 * over an auto-discovered script.
 *
 * On the warm path, this layer reads the app tooling-compilation cache
 * before rediscovering scripts or recompiling command entries. Cache
 * writes are best-effort: a write failure never affects the returned
 * `RegisteredCommand[]`.
 */
import { Effect, Layer } from "effect";

import type { LandofileShape, PluginManifest } from "@lando/sdk/schema";
import {
  CommandRegistry,
  LandofileService,
  PluginRegistry,
  type RegisteredCommand,
} from "@lando/sdk/services";

import { compileAppCommands } from "../cache/command-compiler.ts";
import {
  readFreshAppCommandCacheForCwd,
  writeAppCommandCache,
  writePluginCommandCache,
} from "../cache/command-index-writer.ts";
import type { CommandIndexEntry } from "../cache/command-index.ts";
import { loadUserLandofile } from "../cli/app-resolution.ts";
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

const toRegisteredCommands = (entries: ReadonlyArray<CommandIndexEntry>): ReadonlyArray<RegisteredCommand> =>
  entries.map((entry) => ({
    id: entry.id,
    summary: entry.summary,
    hidden: entry.hidden,
  }));

const writeCachesForLandofile = (
  landofile: LandofileShape,
  entries: ReadonlyArray<CommandIndexEntry>,
  pluginManifests?: ReadonlyArray<PluginManifest>,
): Effect.Effect<void, never> =>
  Effect.all(
    [
      writeAppCommandCache({ landofile, entries }),
      writePluginCommandCache(pluginManifests === undefined ? {} : { manifests: pluginManifests }),
    ],
    {
      concurrency: 2,
      discard: true,
    },
  );

export const CommandRegistryLive = Layer.effect(
  CommandRegistry,
  Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const pluginRegistryOption = yield* Effect.serviceOption(PluginRegistry);
    return {
      list: Effect.gen(function* () {
        const cached = yield* readFreshAppCommandCacheForCwd().pipe(
          Effect.catchAll(() => Effect.succeed(null)),
        );
        if (cached !== null) return toRegisteredCommands(cached.entries);

        const landofile = yield* loadUserLandofile(landofileService);
        const scripts = yield* discoverScriptsForCwd(process.cwd());
        const entries = compileAppCommands(landofile, scripts);
        const pluginManifests =
          pluginRegistryOption._tag === "Some"
            ? yield* pluginRegistryOption.value.list.pipe(Effect.catchAll(() => Effect.succeed(undefined)))
            : undefined;
        yield* writeCachesForLandofile(landofile, entries, pluginManifests);
        return toRegisteredCommands(entries);
      }).pipe(
        Effect.catchAllCause(() =>
          writePluginCommandCache().pipe(Effect.as([] as ReadonlyArray<RegisteredCommand>)),
        ),
      ),
    };
  }),
);
