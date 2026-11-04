/** Cold-path help adapters avoid loading OCLIF. */
import { Effect, Schema } from "effect";

import type { CommandResultEnvelopeFormat } from "@lando/sdk/command-result";
import { encodeCommandResult } from "@lando/sdk/command-result";
import { ToolingCommandUnavailableError } from "@lando/sdk/errors";
import type { ToolingMetadataStatus } from "./tooling-cache-status";

import type { AppCommandIndexPayload } from "@lando/engine/cache/command-index";
import { CORE_VERSION } from "@lando/engine/version";

import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { type ThisAppHelpRow, commonRows } from "./cold-path-output";
import { buildCommandCatalog } from "./command-catalog";
import { activeResultFormat, emitResultLine } from "./compiled-runtime";
import { isEnvelopeResultFormat } from "./format-flags";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";
import { HelpCommandDescriptor } from "./help-command-descriptor";
import { type HelpAliasPolicy, typeableName } from "./help-names";
import { helpRedactor } from "./help-redaction";
import { shouldStyleHelp } from "./help-style";
import { printMachineHelpTarget } from "./help-target";
import { type PluginCommandListing, PluginMetadata } from "./plugin-command-catalog";
import { moreRows } from "./root-help-topics";

import { type ToolingHelpEntry, renderCommandHelp, renderToolingHelp } from "./cli-help";

export { renderCommandHelp, renderToolingHelp } from "./cli-help";

const HELP_CATALOG_COMMAND = "cli:help" as const;

export const HelpCatalogRow = HelpCommandDescriptor;

export const HelpCatalogResult = Schema.Struct({
  version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
  pluginMetadata: PluginMetadata,
  toolingMetadata: Schema.Union([
    Schema.Struct({ status: Schema.Literals(["fresh", "not-app"]) }),
    Schema.Struct({
      status: Schema.Literal("unavailable"),
      reason: ToolingCommandUnavailableError.fields.reason,
      staleReason: ToolingCommandUnavailableError.fields.staleReason,
      sourcePath: ToolingCommandUnavailableError.fields.sourcePath,
      remediation: ToolingCommandUnavailableError.fields.remediation,
    }),
  ]),
  sections: Schema.Struct({
    common: Schema.Array(HelpCatalogRow),
    thisApp: Schema.Array(HelpCatalogRow),
    more: Schema.Array(HelpCatalogRow),
  }),
  all: Schema.Array(HelpCatalogRow),
});

export type HelpCatalogResult = typeof HelpCatalogResult.Type;
type HelpCatalogRow = typeof HelpCatalogRow.Type;

const isBuiltInRegistryId = (id: string): boolean => Object.hasOwn(COMMAND_REGISTRY_MANIFEST.commands, id);

const toToolingHelpEntry = (entry: AppCommandIndexPayload["entries"][number]): ToolingHelpEntry => ({
  id: entry.id,
  summary: entry.summary,
  hidden: entry.hidden,
  ...(entry.service === undefined ? {} : { service: entry.service }),
  ...(entry.input === undefined ? {} : { input: entry.input }),
});

export const toolingHelpEntryForToken = (
  cache: AppCommandIndexPayload,
  token: string,
): ToolingHelpEntry | undefined => {
  const aliasPolicy = cache.aliasPolicy;
  for (const entry of cache.entries) {
    if (entry.hidden || isBuiltInRegistryId(entry.id)) continue;
    if (entry.id === token) return toToolingHelpEntry(entry);
    const name = typeableName({
      canonicalId: entry.id,
      builtInAliases: [],
      implicitNamespaceStrip: true,
      ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
    });
    if (name.primary === token || name.extras.includes(token)) return toToolingHelpEntry(entry);
  }
  return undefined;
};

export const thisAppHelpRowsFromCache = (cache: AppCommandIndexPayload): readonly ThisAppHelpRow[] => {
  const aliasPolicy = cache.aliasPolicy;
  return cache.entries
    .filter((entry) => !entry.hidden && !isBuiltInRegistryId(entry.id))
    .map((entry) => {
      const name = typeableName({
        canonicalId: entry.id,
        builtInAliases: [],
        ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
      });
      return {
        canonicalId: entry.id,
        primary: name.primary,
        extras: name.extras,
        summary: entry.summary,
      };
    })
    .toSorted(
      (left, right) =>
        left.primary.localeCompare(right.primary) || left.canonicalId.localeCompare(right.canonicalId),
    );
};

const toCatalogRow = (row: ThisAppHelpRow, source: "built-in" | "tooling"): HelpCatalogRow => ({
  typeable: row.primary,
  extras: [...row.extras],
  canonicalId: row.canonicalId,
  summary: row.summary,
  source,
});

const byTypeable = (left: HelpCatalogRow, right: HelpCatalogRow): number =>
  left.typeable.localeCompare(right.typeable) || left.canonicalId.localeCompare(right.canonicalId);

export const pluginRowsForCache = (
  rows: PluginCommandListing["rows"],
  cache?: AppCommandIndexPayload | null,
): PluginCommandListing["rows"] => {
  return buildCommandCatalog(rows, cache).entries.flatMap((entry) =>
    entry.plugin === undefined || entry.hidden ? [] : [{ ...entry.plugin, tokens: entry.tokens }],
  );
};

export const buildHelpCatalog = (
  cache?: AppCommandIndexPayload | null,
  metadata?: ToolingMetadataStatus,
  plugins?: PluginCommandListing,
): HelpCatalogResult => {
  const aliasPolicy = cache?.aliasPolicy;
  const common = commonRows(aliasPolicy).map((row) => toCatalogRow(row, "built-in"));
  const thisApp =
    cache == null ? [] : thisAppHelpRowsFromCache(cache).map((row) => toCatalogRow(row, "tooling"));
  const more = moreRows(plugins?.topics).map((row) => ({
    typeable: row.token,
    extras: [],
    canonicalId: row.token,
    summary: row.summary,
    source: "built-in" as const,
  }));
  const catalog = buildCommandCatalog(plugins?.rows ?? [], cache);
  return {
    version: CORE_VERSION,
    platform: process.platform,
    arch: process.arch,
    toolingMetadata: metadata ?? { status: cache == null ? "not-app" : "fresh" },
    pluginMetadata: plugins?.metadata ?? { status: "available" },
    sections: { common, thisApp, more },
    all: catalog.entries
      .filter((entry) => !entry.hidden)
      .map((entry): HelpCatalogRow => {
        const row = {
          canonicalId: entry.id,
          typeable: entry.primary,
          extras: entry.extras,
          summary: entry.summary,
        };
        if (entry.plugin !== undefined)
          return {
            ...row,
            source: "plugin",
            plugin: entry.plugin.pluginName,
            provenance: entry.plugin.source,
            implementation: entry.plugin.spec === undefined ? "discovered" : "validated",
            ...(entry.plugin.loadError === undefined ? {} : { loadError: entry.plugin.loadError }),
          };
        return { ...row, source: entry.source === "tooling" ? "tooling" : "built-in" };
      })
      .toSorted(byTypeable),
  };
};

export const printHelpCatalogJson = (
  cache?: AppCommandIndexPayload | null,
  format: CommandResultEnvelopeFormat = "json",
  metadata?: ToolingMetadataStatus,
  plugins?: PluginCommandListing,
): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      const redactor = yield* helpRedactor;
      const line = yield* encodeCommandResult({
        command: HELP_CATALOG_COMMAND,
        resultSchema: HelpCatalogResult,
        outcome: { _tag: "success", value: buildHelpCatalog(cache, metadata, plugins) },
        redactor,
        format,
      });
      yield* Effect.promise(() => emitResultLine(line));
    }),
  );

const rendererModeFrom = (
  argv: ReadonlyArray<string>,
  env: Readonly<Record<string, string | undefined>>,
): string | undefined => {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") break;
    if (arg === "--renderer") return argv[index + 1];
    if (arg?.startsWith("--renderer=")) return arg.slice("--renderer=".length);
  }
  const fromEnv = env.LANDO_RENDERER;
  return fromEnv === undefined || fromEnv === "" ? undefined : fromEnv;
};

export const printCommandHelp = (entry: BuiltInCommandEntry): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) {
    return printMachineHelpTarget(
      {
        canonicalId: entry.spec.id,
        typeable: entry.spec.id,
        extras: [],
        summary: entry.spec.summary,
        source: "built-in",
      },
      activeResultFormat,
    );
  }
  const argv = process.argv.slice(2);
  return emitResultLine(
    renderCommandHelp(entry, {
      styled: shouldStyleHelp({
        isTTY: process.stdout.isTTY === true,
        env: process.env,
        argv,
        rendererMode: rendererModeFrom(argv, process.env),
      }),
    }),
  );
};

export const printToolingHelp = (entry: ToolingHelpEntry, aliasPolicy?: HelpAliasPolicy): Promise<void> => {
  if (isEnvelopeResultFormat(activeResultFormat)) {
    const names = typeableName({
      canonicalId: entry.id,
      builtInAliases: [],
      implicitNamespaceStrip: true,
      ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
    });
    return printMachineHelpTarget(
      {
        canonicalId: entry.id,
        typeable: names.primary,
        extras: [...names.extras],
        summary: entry.summary,
        source: "tooling",
        ...(entry.input === undefined ? {} : { input: entry.input }),
      },
      activeResultFormat,
    );
  }
  const argv = process.argv.slice(2);
  return emitResultLine(
    renderToolingHelp(entry, {
      styled: shouldStyleHelp({
        isTTY: process.stdout.isTTY === true,
        env: process.env,
        argv,
        rendererMode: rendererModeFrom(argv, process.env),
      }),
      ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
    }),
  );
};
