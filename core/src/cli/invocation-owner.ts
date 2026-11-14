import type {
  BunShellScriptEmptyError,
  BunShellScriptFrontMatterError,
  CacheError,
  CommandAliasConflictError,
  CommandAliasTargetError,
  LandofileFormConflictError,
  NotImplementedError,
} from "@lando/sdk/errors";
import { ToolingDisabledError } from "@lando/sdk/errors";
import type { ExecutableCommandSpec } from "@lando/sdk/plugins";
import { Effect, Exit } from "effect";
import type { CliInvocationContext } from "../runtime/invocation-context";
import { CliInvocation } from "../runtime/invocation-context";
import {
  type BuiltInCommandEntry,
  isReservedNamespaceHead,
  resolveBuiltInCommand,
} from "./built-in-command-registry";
import { flagDefinitionsForCommand } from "./compiled-argv";
import { NO_CLAIMS, nonePolicy, specOwnerPolicy, toolingPolicy } from "./flag-claims";
import { hostProxyDenied } from "./host-proxy/call-context";
import { interruptOnAbort } from "./interrupt-on-abort";
import type { InvocationHead, OwnerPolicy } from "./invocation";
import type {
  PluginCommandCatalog,
  PluginCommandDiagnostic,
  PluginCommandRow,
} from "./plugin-command-catalog";
import { pluginFlagDefinitions } from "./plugin-flag-definitions";
import { preCommandOutputMode } from "./spec/command-boundary";
import { type NormalizedToolingRoute, type ToolingRoute, resolveToolingRoute } from "./tooling-router";
import { unavailableToolingError } from "./tooling-unavailable";

type ToolingRefusal =
  | NonNullable<Effect.Success<ReturnType<typeof unavailableToolingError>>>
  | ToolingDisabledError;

export type AliasResolutionFailure =
  | CacheError
  | LandofileFormConflictError
  | CommandAliasConflictError
  | CommandAliasTargetError
  | BunShellScriptEmptyError
  | BunShellScriptFrontMatterError
  | NotImplementedError;

type UnavailablePluginRow = { readonly unavailable: PluginCommandDiagnostic };
type ResolvedPluginRow = PluginCommandRow | UnavailablePluginRow;
export type LoadedPluginRow = PluginCommandRow & { readonly spec: ExecutableCommandSpec };

/** Who owns the token typed as the command name, decided once per invocation. */
export type InvocationOwner =
  | { readonly kind: "none" }
  | { readonly kind: "help" }
  | { readonly kind: "built-in"; readonly entry: BuiltInCommandEntry }
  | {
      readonly kind: "tooling";
      readonly route: NormalizedToolingRoute;
      readonly refusal?: ToolingRefusal;
    }
  | { readonly kind: "plugin"; readonly token: string; readonly row: LoadedPluginRow }
  | {
      readonly kind: "plugin-unloaded";
      readonly token: string;
      readonly row: ResolvedPluginRow;
    }
  | {
      readonly kind: "cache-miss";
      readonly token: string;
      readonly route: Extract<ToolingRoute, { readonly _tag: "cache-miss" }>;
    }
  | { readonly kind: "alias-disabled"; readonly token: string }
  | { readonly kind: "route-failure"; readonly failure: AliasResolutionFailure }
  | { readonly kind: "unknown"; readonly token: string };

const helpClaims: OwnerPolicy["claims"] = (token) =>
  token === "--help" || token === "-h" || token === "--all" ? { takesNext: false } : undefined;

/** The tokens each owner reads after its command name. Pure and synchronous. */
export const ownerPolicy = (owner: InvocationOwner): OwnerPolicy => {
  switch (owner.kind) {
    case "help":
      return { tail: "none", claims: helpClaims, reservedOutput: [] };
    case "built-in":
      return specOwnerPolicy(owner.entry.spec, flagDefinitionsForCommand(owner.entry.spec));
    case "plugin":
      return specOwnerPolicy(owner.row.spec, pluginFlagDefinitions(owner.row.spec));
    case "plugin-unloaded":
      return { tail: "all", claims: NO_CLAIMS, reservedOutput: [] };
    case "tooling":
      if (owner.refusal !== undefined) return nonePolicy(false);
      return toolingPolicy(owner.route.input, {
        ...(owner.route.disabled === true ? { disabled: true as const } : {}),
        ...(owner.route.wrapper === true ? { wrapper: true as const } : {}),
      });
    case "none":
    case "cache-miss":
    case "alias-disabled":
    case "route-failure":
    case "unknown":
      return { tail: "none", claims: NO_CLAIMS, reservedOutput: [] };
    default:
      return owner satisfies never;
  }
};

export interface ResolveInvocationOwnerInput {
  readonly head: InvocationHead;
  readonly rawArgv: ReadonlyArray<string>;
  readonly catalog: PluginCommandCatalog;
  readonly context: CliInvocationContext;
  readonly hostProxy: boolean;
  readonly signal?: AbortSignal;
  /** Runs the selection chain over leading Lando flags; true when it rendered a failure. */
  readonly precheckLeadingFlags: (globals: ReadonlyArray<string>) => Promise<boolean>;
}

const isLoadedRow = (row: ResolvedPluginRow | undefined): row is LoadedPluginRow =>
  row !== undefined && !("unavailable" in row) && row.spec !== undefined;

const resolveToolingRouteExit = async (token: string, input: ResolveInvocationOwnerInput) => {
  const exit = await Effect.runPromiseExit(
    interruptOnAbort(
      Effect.result(
        resolveToolingRoute(token, {
          catalog: input.catalog,
          // A host-proxy child reads the app's alias policy but never rebuilds the index.
          rebuild: !input.hostProxy,
          // Output modes are not resolved yet; machine-output argv/env still silences the notice.
          rebuildNotice:
            preCommandOutputMode({ argv: input.rawArgv, env: input.context.env }).rendererMode !== "json",
        }),
      ),
      input.signal,
    ).pipe(Effect.provideService(CliInvocation, input.context)),
  );
  if (Exit.isFailure(exit)) throw exit.cause;
  return exit.value;
};

const pluginTokenFor = (
  route: ToolingRoute | undefined,
  fallbackToken: string,
  hostProxy: boolean,
): string | undefined => {
  if (hostProxy) return undefined;
  if (route === undefined) return fallbackToken;
  switch (route._tag) {
    case "plugin":
      return route.token;
    case "unknown-tooling":
    case "not-tooling":
      return fallbackToken;
    case "built-in":
    case "tooling":
    case "bun-script":
    case "cache-miss":
    case "alias-disabled":
      return undefined;
    default:
      return route satisfies never;
  }
};

/**
 * Resolve the one owner of this invocation in routing order: canonical
 * built-in, leading-flag pre-check, guarded routing, host-proxy admission
 * before any plugin row loads, then the built-in alias and plugin fallbacks.
 */
export const resolveInvocationOwner = async (
  input: ResolveInvocationOwnerInput,
): Promise<InvocationOwner | "handled"> => {
  const token = input.head.commandId;
  if (token === undefined) return { kind: "none" };
  if (token === "help") return { kind: "help" };

  const registered = resolveBuiltInCommand(token);
  if (registered !== undefined && registered.spec.id === token) {
    return { kind: "built-in", entry: registered };
  }

  // A lead that already selects an unusable mode fails before routing, which
  // may import plugin modules to rebuild the command index.
  if (input.head.headGlobals.length > 0 && (await input.precheckLeadingFlags(input.head.headGlobals)))
    return "handled";

  let route: ToolingRoute | undefined;
  if (!token.startsWith("-") && (registered !== undefined || !isReservedNamespaceHead(token))) {
    const resolution = await resolveToolingRouteExit(token, input);
    if (resolution._tag === "Failure") return { kind: "route-failure", failure: resolution.failure };
    route = resolution.success;
  }

  // Host-proxy admission: only a built-in may own the token, decided before any plugin code loads.
  if (input.hostProxy && route !== undefined && route._tag !== "built-in") {
    throw hostProxyDenied("cli:route");
  }

  // A route that does not claim the token leaves a built-in alias (bun, x, run)
  // as the owner; a failed route still renders its own diagnostic.
  if (route?._tag === "built-in") return { kind: "built-in", entry: route.entry };
  if (route === undefined || route._tag === "not-tooling" || route._tag === "cache-miss") {
    const alias = resolveBuiltInCommand(token);
    if (alias !== undefined) return { kind: "built-in", entry: alias };
  }

  if (route?._tag === "tooling" || route?._tag === "bun-script") {
    const refusal =
      route.disabled === true
        ? new ToolingDisabledError({
            message: `Tooling command ${route.name} is disabled.`,
            tool: route.name,
            source: { path: route.sourcePath, task: route.name },
            remediation: "Enable this task in the app's tooling definition before running it.",
          })
        : route.loadError === undefined
          ? undefined
          : await Effect.runPromise(unavailableToolingError(route));
    return {
      kind: "tooling",
      route,
      ...(refusal === undefined ? {} : { refusal }),
    };
  }
  if (route?._tag === "alias-disabled") return { kind: "alias-disabled", token: route.token };
  if (route?._tag === "cache-miss") return { kind: "cache-miss", token, route };

  const pluginToken = pluginTokenFor(route, token, input.hostProxy);
  if (pluginToken !== undefined) {
    const row = await input.catalog.resolve(pluginToken);
    if (row !== undefined) {
      if (isLoadedRow(row) && row.loadError === undefined) {
        return { kind: "plugin", token: pluginToken, row };
      }
      return { kind: "plugin-unloaded", token: pluginToken, row };
    }
  }
  return { kind: "unknown", token };
};
