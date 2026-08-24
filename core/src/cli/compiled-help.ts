/** Cold-path help adapters avoid loading OCLIF. */
import { Effect, Schema } from "effect";

import { encodeCommandResult, identityRedactor } from "@lando/sdk/command-result";

import type { AppCommandIndexPayload } from "@lando/engine/cache/command-index";
import { CORE_VERSION } from "@lando/engine/version";

import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { renderCommandHelp } from "./cli-help";
import {
  MORE_ROWS,
  type ThisAppHelpRow,
  commonRows,
  renderColdRootHelp,
  visibleHelpRows,
} from "./cold-path-output";
import { emitResultLine } from "./compiled-runtime";
import { COMMAND_REGISTRY_MANIFEST } from "./generated/command-registry-manifest";
import { typeableName } from "./help-names";
import { shouldStyleHelp } from "./help-style";

export { renderCommandHelp, renderToolingHelp } from "./cli-help";

const HELP_CATALOG_COMMAND = "cli:help" as const;

export const HelpCatalogRow = Schema.Struct({
  typeable: Schema.String,
  extras: Schema.Array(Schema.String),
  canonicalId: Schema.String,
  summary: Schema.String,
  source: Schema.Literal("built-in", "tooling"),
});

export const HelpCatalogResult = Schema.Struct({
  version: Schema.String,
  platform: Schema.String,
  arch: Schema.String,
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

const toCatalogRow = (row: ThisAppHelpRow, source: HelpCatalogRow["source"]): HelpCatalogRow => ({
  typeable: row.primary,
  extras: [...row.extras],
  canonicalId: row.canonicalId,
  summary: row.summary,
  source,
});

const byTypeable = (left: HelpCatalogRow, right: HelpCatalogRow): number =>
  left.typeable.localeCompare(right.typeable) || left.canonicalId.localeCompare(right.canonicalId);

export const buildHelpCatalog = (cache?: AppCommandIndexPayload | null): HelpCatalogResult => {
  const aliasPolicy = cache?.aliasPolicy;
  const common = commonRows(aliasPolicy).map((row) => toCatalogRow(row, "built-in"));
  const thisApp =
    cache == null ? [] : thisAppHelpRowsFromCache(cache).map((row) => toCatalogRow(row, "tooling"));
  const more = MORE_ROWS.map((row) => ({
    typeable: row.token,
    extras: [],
    canonicalId: row.token,
    summary: row.summary,
    source: "built-in" as const,
  }));
  const builtIns = visibleHelpRows(aliasPolicy).map((row) => toCatalogRow(row, "built-in"));
  return {
    version: CORE_VERSION,
    platform: process.platform,
    arch: process.arch,
    sections: { common, thisApp, more },
    all: [...builtIns, ...thisApp].toSorted(byTypeable),
  };
};

export const printHelpCatalogJson = (cache?: AppCommandIndexPayload | null): void => {
  const line = Effect.runSync(
    encodeCommandResult({
      command: HELP_CATALOG_COMMAND,
      resultSchema: HelpCatalogResult,
      outcome: { _tag: "success", value: buildHelpCatalog(cache) },
      redactor: identityRedactor,
    }),
  );
  emitResultLine(line);
};

export const printRootHelp = (
  activeAliases?: ReadonlyArray<readonly [string, string]>,
  cache?: AppCommandIndexPayload | null,
): void => {
  if (cache == null) {
    emitResultLine(renderColdRootHelp(activeAliases));
    return;
  }
  emitResultLine(
    renderColdRootHelp(activeAliases, {
      thisAppRows: thisAppHelpRowsFromCache(cache),
      ...(cache.aliasPolicy === undefined ? {} : { aliasPolicy: cache.aliasPolicy }),
    }),
  );
};

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

export const printCommandHelp = (entry: BuiltInCommandEntry): void => {
  const argv = process.argv.slice(2);
  emitResultLine(
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
