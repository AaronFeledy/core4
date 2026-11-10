import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import type { CommandAliasConflictError, CommandAliasTargetError } from "@lando/sdk/errors";
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

import type { LandofileShape } from "@lando/sdk/schema";
import { CommandRegistry, LandofileService, PathsService, type RegisteredCommand } from "@lando/sdk/services";

import { inspectBunShellScripts } from "@lando/landofile/bun-sh-discovery";
import { findAppRoot } from "@lando/landofile/discovery";
import { discoveryCwd } from "@lando/landofile/operation-discovery";
import { createRedactor } from "@lando/sdk/secrets";
import { compileInspectedAppCommands } from "../cache/command-compiler.ts";
import { readFreshAppCommandCacheForCwd, writeAppCommandCache } from "../cache/command-index-writer.ts";
import type { CommandIndexEntry } from "../cache/command-index.ts";
import { fingerprintsFromInspection } from "../cache/command-script-freshness.ts";
import { loadUserLandofile } from "../landofile/app-resolution.ts";
import { PluginContributionGraph } from "../plugins/contribution-graph.ts";

const discoverScriptsForCwd = Effect.fnUntraced(function* (cwd: string) {
  const appRoot = yield* findAppRoot(cwd);
  if (appRoot === undefined) return { scripts: [], problems: [], files: [] };
  return yield* inspectBunShellScripts({ appRoot });
});

const toRegisteredCommands = (entries: ReadonlyArray<CommandIndexEntry>): ReadonlyArray<RegisteredCommand> =>
  entries
    .filter((entry) => entry.loadError === undefined)
    .map((entry) => ({
      id: entry.id,
      summary: entry.summary,
      hidden: entry.hidden,
      ...(entry.input === undefined ? {} : { input: entry.input }),
      ...(entry.runs === undefined ? {} : { runs: entry.runs }),
    }));

export const layerWith = (
  registrationError: (
    policy: LandofileShape["commandAliases"],
    entries: ReadonlyArray<CommandIndexEntry>,
    pluginCommandIds: readonly string[],
  ) => CommandAliasConflictError | CommandAliasTargetError | undefined,
) =>
  Layer.effect(
    CommandRegistry,
    Effect.gen(function* () {
      const landofileService = yield* LandofileService;
      const paths = yield* Effect.serviceOption(PathsService);
      const graph = yield* Effect.serviceOption(PluginContributionGraph);
      const pluginCommandIds = graph._tag === "Some" ? graph.value.commands.map((entry) => entry.id) : [];
      const cacheOptions = paths._tag === "Some" ? { cacheRoot: paths.value.roots.userCacheRoot } : {};
      return CommandRegistry.of({
        list: Effect.gen(function* () {
          const cached = yield* readFreshAppCommandCacheForCwd({
            ...cacheOptions,
            includeScriptInventory: true,
          }).pipe(Effect.catch(() => Effect.succeed(null)));
          if (cached !== null) {
            const error = registrationError(cached.aliasPolicy, cached.entries, pluginCommandIds);
            if (error !== undefined) return yield* Effect.fail(error);
            return toRegisteredCommands(cached.entries);
          }

          const landofile = (yield* loadUserLandofile(landofileService)).document;
          const scripts = yield* discoverScriptsForCwd(yield* discoveryCwd());
          const hasServices = Object.keys(landofile.services ?? {}).length > 0;
          if (hasServices) {
            return [];
          }
          const redaction = yield* Effect.serviceOption(RedactionService);
          const redactor =
            redaction._tag === "Some"
              ? yield* redaction.value.forProfile("secrets")
              : createRedactor("secrets", { values: collectSecretEnvValues(process.env) });
          const entries = compileInspectedAppCommands({
            landofile,
            inspection: scripts,
            redact: redactor.redactString,
          });
          const error = registrationError(landofile.commandAliases, entries, pluginCommandIds);
          if (error !== undefined) return yield* Effect.fail(error);
          yield* writeAppCommandCache({
            sourceScripts: fingerprintsFromInspection(scripts),
            landofile,
            entries,
            ...cacheOptions,
          });
          return toRegisteredCommands(entries);
        }).pipe(Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<RegisteredCommand>))),
      });
    }),
  );

export const layer = layerWith(() => undefined);
