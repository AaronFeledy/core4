import type { AppCommandIndexPayload, CommandIndexEntry } from "@lando/engine/cache/command-index";
import { canonicalIdFromRelativePath } from "@lando/landofile/bun-sh-discovery";
import type { ToolingCommandUnavailableError } from "@lando/sdk/errors";
import type { BuiltInCommandEntry } from "./built-in-command-registry";

interface ToolingRouteMetadata {
  readonly commandId: string;
  readonly name: string;
  readonly summary: string;
  readonly hidden: boolean;
  readonly disabled?: true;
  readonly sourcePath?: string;
  readonly service?: string;
  readonly input?: NonNullable<CommandIndexEntry["input"]>;
  readonly aliasPolicy?: NonNullable<AppCommandIndexPayload["aliasPolicy"]>;
}

export type ToolingRoute =
  | { readonly _tag: "not-tooling" }
  | { readonly _tag: "built-in"; readonly commandId: string; readonly entry: BuiltInCommandEntry }
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
      readonly _tag: "unknown-tooling";
      readonly commandId: string;
      readonly name: string;
      readonly remediation: string;
    }
  | (ToolingRouteMetadata & { readonly _tag: "tooling" })
  | (ToolingRouteMetadata & {
      readonly _tag: "bun-script";
      readonly appRoot: string;
      readonly relativePath?: string;
    });

export type NormalizedToolingRoute = Extract<ToolingRoute, { readonly _tag: "tooling" | "bun-script" }>;

export const normalizedToolingRoute = (
  entry: CommandIndexEntry,
  aliasPolicy: AppCommandIndexPayload["aliasPolicy"],
  sourcePath?: string,
): Extract<ToolingRoute, { readonly _tag: "tooling" }> => ({
  _tag: "tooling",
  commandId: entry.id,
  name: entry.id.startsWith("app:") ? entry.id.slice("app:".length) : entry.id,
  summary: entry.summary,
  hidden: entry.hidden,
  ...(entry.disabled === undefined ? {} : { disabled: entry.disabled }),
  ...(entry.hidden && sourcePath !== undefined ? { sourcePath } : {}),
  ...(entry.service === undefined ? {} : { service: entry.service }),
  ...(entry.input === undefined ? {} : { input: entry.input }),
  ...(aliasPolicy === undefined ? {} : { aliasPolicy }),
});

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

export const toolingHelpRequested = (
  route: ToolingRoute,
  argv: ReadonlyArray<string>,
): route is NormalizedToolingRoute => {
  switch (route._tag) {
    case "tooling":
    case "bun-script":
      if (!route.disabled) {
        if (route.input === undefined) return false;
        if (route.input.acceptsArguments && route.input.flags.length === 0 && route.input.args.length === 0)
          return false;
        if (route.input.flags.some((flag) => flag.name === "help" || flag.alias === "h")) return false;
      }
      for (const token of argv) {
        if (token === "--") return false;
        if (token === "--help" || token === "-h") return true;
      }
      return false;
    case "not-tooling":
    case "built-in":
    case "alias-disabled":
    case "cache-miss":
    case "unknown-tooling":
      return false;
    default:
      return route satisfies never;
  }
};
