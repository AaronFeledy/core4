import {
  type AppCommandIndexPayload,
  type CommandIndexEntry,
  type CommandIndexPresentation,
  commandIndexPresentation,
} from "@lando/engine/cache/command-index";
import { canonicalIdFromRelativePath } from "@lando/landofile/bun-sh-discovery";
import type { ToolingCommandUnavailableError } from "@lando/sdk/errors";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { type HelpAliasPolicy, type TypeableName, typeableName } from "./help-names";
import type { ToolingRebuildFailure } from "./tooling-cache-status";

interface ToolingRouteMetadata {
  readonly commandId: string;
  readonly name: string;
  readonly summary: string;
  readonly hidden: boolean;
  readonly disabled?: true;
  readonly sourcePath?: string;
  readonly service?: string;
  readonly input?: NonNullable<CommandIndexPresentation["input"]>;
  readonly wrapper?: true;
  readonly runs?: NonNullable<CommandIndexPresentation["runs"]>;
  readonly loadError?: NonNullable<CommandIndexPresentation["loadError"]>;
  readonly aliasPolicy?: NonNullable<AppCommandIndexPayload["aliasPolicy"]>;
}

export type ToolingRoute =
  | { readonly _tag: "not-tooling" }
  | { readonly _tag: "built-in"; readonly commandId: string; readonly entry: BuiltInCommandEntry }
  | { readonly _tag: "plugin"; readonly commandId: string; readonly token: string }
  | { readonly _tag: "alias-disabled"; readonly token: string }
  | {
      readonly _tag: "cache-miss";
      readonly reason: "missing-cache" | "stale-cache" | "invalid-cache";
      readonly staleReason?: ToolingCommandUnavailableError["staleReason"];
      readonly sourcePath?: string;
      readonly commandId: string;
      readonly name: string;
      readonly remediation: string;
    }
  | {
      readonly _tag: "cache-miss";
      readonly reason: "rebuild-failed";
      readonly sourcePath: string;
      readonly commandId: string;
      readonly name: string;
      readonly error: ToolingRebuildFailure;
    }
  | {
      readonly _tag: "unknown-tooling";
      readonly commandId: string;
      readonly name: string;
    }
  | (ToolingRouteMetadata & { readonly _tag: "tooling" })
  | (ToolingRouteMetadata & {
      readonly _tag: "bun-script";
      readonly appRoot: string;
      readonly relativePath?: string;
    });

export type NormalizedToolingRoute = Extract<ToolingRoute, { readonly _tag: "tooling" | "bun-script" }>;

/** The name a user types for a tooling route: implicit namespace strip plus any alias policy. */
export const toolingTypeableName = (canonicalId: string, aliasPolicy?: HelpAliasPolicy): TypeableName =>
  typeableName({
    canonicalId,
    builtInAliases: [],
    implicitNamespaceStrip: true,
    ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
  });

export const normalizedToolingRoute = (
  entry: CommandIndexEntry,
  aliasPolicy: AppCommandIndexPayload["aliasPolicy"],
  sourcePath?: string,
): Extract<ToolingRoute, { readonly _tag: "tooling" }> => {
  const { id: _id, source: _source, ...metadata } = commandIndexPresentation(entry);
  return {
    ...metadata,
    _tag: "tooling",
    commandId: entry.id,
    name: entry.id.startsWith("app:") ? entry.id.slice("app:".length) : entry.id,
    summary: entry.summary,
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(entry._tag === "Disabled" ? { sourcePath: entry.source.path } : {}),
    ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
  };
};

export const bunScriptRoute = (
  entry: CommandIndexEntry,
  appRoot: string,
  cache: AppCommandIndexPayload,
): Extract<ToolingRoute, { readonly _tag: "bun-script" }> => {
  const relativePath = cache.sourceScripts?.find(
    (script) => canonicalIdFromRelativePath(script.relativePath)?.id === entry.id,
  )?.relativePath;
  return {
    ...normalizedToolingRoute(entry, cache.aliasPolicy, cache.sourceFile),
    _tag: "bun-script",
    appRoot,
    ...(relativePath === undefined ? {} : { relativePath }),
  };
};

export const toolingVersionRequested = (route: ToolingRoute, argv: ReadonlyArray<string>): boolean => {
  switch (route._tag) {
    case "tooling":
    case "bun-script":
      if (argv.length !== 1 || argv[0] !== "--version") return false;
      return !route.wrapper && !route.input?.flags.some((flag) => flag.name === "version");
    case "not-tooling":
    case "built-in":
    case "plugin":
    case "alias-disabled":
    case "cache-miss":
    case "unknown-tooling":
      return false;
    default:
      return route satisfies never;
  }
};
