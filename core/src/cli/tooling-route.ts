import type {
  AppCommandIndexPayload,
  CommandIndexEntry,
  DisabledCommandIndexEntry,
  ReadyCommandIndexEntry,
  UnavailableCommandIndexEntry,
} from "@lando/engine/cache/command-index";
import { canonicalIdFromRelativePath } from "@lando/landofile/bun-sh-discovery";
import type { ToolingCommandUnavailableError } from "@lando/sdk/errors";
import type { BuiltInCommandEntry } from "./built-in-command-registry";
import { type HelpAliasPolicy, type TypeableName, typeableName } from "./help-names";
import type { ToolingRebuildFailure } from "./tooling-cache-status";

export type ToolingAvailability =
  | Pick<ReadyCommandIndexEntry, "_tag" | "input" | "service" | "wrapper" | "runs" | "readsRouteFacts">
  | Pick<DisabledCommandIndexEntry, "_tag" | "source">
  | Pick<UnavailableCommandIndexEntry, "_tag" | "diagnostic">;

type ToolingRouteMetadata = {
  readonly commandId: string;
  readonly name: string;
  readonly summary: string;
  readonly hidden: boolean;
  readonly availability: ToolingAvailability;
  readonly aliasPolicy?: NonNullable<AppCommandIndexPayload["aliasPolicy"]>;
};

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
): Extract<ToolingRoute, { readonly _tag: "tooling" }> => {
  let availability: ToolingAvailability;
  switch (entry._tag) {
    case "Ready":
      availability = {
        _tag: "Ready",
        input: entry.input,
        ...(entry.service === undefined ? {} : { service: entry.service }),
        ...(entry.wrapper === undefined ? {} : { wrapper: entry.wrapper }),
        ...(entry.runs === undefined ? {} : { runs: entry.runs }),
        ...(entry.readsRouteFacts === undefined ? {} : { readsRouteFacts: entry.readsRouteFacts }),
      };
      break;
    case "Disabled":
      availability = { _tag: "Disabled", source: entry.source };
      break;
    case "Unavailable":
      availability = { _tag: "Unavailable", diagnostic: entry.diagnostic };
      break;
    default:
      return entry satisfies never;
  }
  return {
    availability,
    hidden: entry.visibility === "internal",
    _tag: "tooling" as const,
    commandId: entry.id,
    name: entry.id.startsWith("app:") ? entry.id.slice("app:".length) : entry.id,
    summary: entry.summary,
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
    ...normalizedToolingRoute(entry, cache.aliasPolicy),
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
      switch (route.availability._tag) {
        case "Ready":
          return (
            !route.availability.wrapper &&
            !route.availability.input.flags.some((flag) => flag.name === "version")
          );
        case "Disabled":
        case "Unavailable":
          return false;
        default:
          return route.availability satisfies never;
      }
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
