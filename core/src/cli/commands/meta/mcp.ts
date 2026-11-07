/**
 * `meta:mcp` (`lando mcp`) command logic.
 *
 * Two modes share one option/validation core:
 *   - `--list` projects the effective tool catalog (id, summary, source of
 *     allowance) as a normal machine-output result (`McpListResult`).
 *   - serve mode runs the long-running stdio MCP server: it constructs
 *     the MCP service layer lazily, drives `McpService.serve` over Effect's
 *     stdio server, and emits no command-result envelope, preserving
 *     the MCP protocol stream.
 *
 * Built-in entries are injected so this module stays out of the command-graph
 * import cycle.
 */
import { Effect, Exit, type Layer, Option, type Result } from "effect";

import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import type { McpToolInputError, McpTransportError } from "@lando/sdk/errors";
import type { McpConfig } from "@lando/sdk/schema";
import { ConfigService } from "@lando/sdk/services";

import { MCP_DEFAULT_ALLOWLIST } from "@lando/mcp/generated-allowlist";
import { McpRuntimeConfig, type McpRuntimeConfigShape, McpService } from "@lando/mcp/service";
import { mcpServeStartupError } from "@lando/mcp/stdio-limits";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import * as RendererStdio from "@lando/renderer/stdio";
import { serviceLayer } from "../../../mcp-command-executor";
import { resources } from "../../../mcp-resources";
import type { LandoGenerationRuntime } from "../../../runtime/layer";
import type { RendererMode } from "../../bug-report";
import { BuiltInCommandCatalog } from "../../built-in-command-catalog-service";
import type { CliInvocationSnapshot } from "../../command-lifecycle";
import type { ResultFormat } from "../../format-flags";
import { runWithRendererHandling } from "../../renderer-boundary";
import type { McpAppGenerations } from "./mcp-app-generations";
import { type McpListResult, McpListResultSchema, buildMcpListResult, renderMcpListResult } from "./mcp-list";
import {
  type McpCommandRegistry,
  type ResolvedMcpOptions,
  defaultIdsOf,
  knownIdsOf,
  mcpRegistryFromBuiltIns,
  pendingAllowanceDiagnostics,
  validateMcpAllowlistIds,
} from "./mcp-registry";
import { openMcpSession, sessionAppRegistry } from "./mcp-session";
export {
  type McpCommandRegistry,
  type ResolvedMcpOptions,
  mcpRegistryFromBuiltIns,
  mcpRegistryWithToolingEntries,
  validateMcpAllowlistIds,
} from "./mcp-registry";

export interface McpCommandFlags {
  readonly allow?: ReadonlyArray<string> | undefined;
  readonly deny?: ReadonlyArray<string> | undefined;
  readonly tooling?: boolean | undefined;
  readonly list?: boolean | undefined;
}

export { classifyMcpServeStartup } from "@lando/mcp/stdio-limits";

const parsedStringArray = (value: unknown): ReadonlyArray<string> | undefined => {
  if (!Array.isArray(value)) return undefined;
  const strings = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  return strings.length === 0 ? undefined : strings;
};

export const mcpFlagsFromParsed = (flags: Record<string, unknown>): McpCommandFlags => {
  const allow = parsedStringArray(flags.allow);
  const deny = parsedStringArray(flags.deny);
  return {
    ...(allow === undefined ? {} : { allow }),
    ...(deny === undefined ? {} : { deny }),
    tooling: flags.tooling === true,
    list: flags.list === true,
  };
};

/**
 * Compose CLI flags with global `mcp.*` config. Deny is unioned here and wins
 * over allow downstream in `computeEffectiveAllowlist`; tooling is `true` when
 * either the flag or the config enables it.
 */
export const resolveMcpOptions = (
  flags: McpCommandFlags,
  config: McpConfig | undefined,
): ResolvedMcpOptions => ({
  allow: [...(config?.allow ?? []), ...(flags.allow ?? [])],
  deny: [...(config?.deny ?? []), ...(flags.deny ?? [])],
  tooling: (config?.tooling ?? false) || flags.tooling === true,
  ...(config?.maxConcurrent === undefined ? {} : { maxConcurrent: config.maxConcurrent }),
});

const toolingEnabled = Effect.fnUntraced(function* (flags: McpCommandFlags) {
  const config = yield* Effect.flatMap(ConfigService, (service) => service.get("mcp"));
  return resolveMcpOptions(flags, config).tooling;
});

const resolveOptions = Effect.fnUntraced(function* (
  registry: McpCommandRegistry,
  flags: McpCommandFlags,
): Effect.fn.Return<
  { readonly options: ResolvedMcpOptions; readonly pending: ReadonlyArray<string> },
  McpToolInputError,
  ConfigService
> {
  const config = yield* Effect.flatMap(ConfigService, (service) => service.get("mcp"));
  const options = resolveMcpOptions(flags, config);
  const pending = yield* validateMcpAllowlistIds(options, knownIdsOf(registry));
  return { options, pending };
});

export const buildMcpRuntimeConfig = (
  registry: McpCommandRegistry,
  apps: McpAppGenerations,
): McpRuntimeConfigShape => ({
  commandEntries: registry.commandEntries,
  ...(registry.toolingEntries === undefined ? {} : { toolingEntries: registry.toolingEntries }),
  // Per-app owners are authorized against the reviewed defaults by their own provenance.
  defaultAllowlist: MCP_DEFAULT_ALLOWLIST,
  resources,
  apps: Effect.succeed(apps),
});

export const mcpListResult = Effect.fn("Mcp.list")(function* (
  registry: McpCommandRegistry,
  flags: McpCommandFlags,
): Effect.fn.Return<McpListResult, McpToolInputError, ConfigService> {
  const { options, pending } = yield* resolveOptions(registry, flags);
  const redaction = yield* Effect.serviceOption(RedactionService);
  const redactor = Option.isSome(redaction)
    ? yield* redaction.value.forProfile("secrets", { sourceEnv: process.env })
    : createStandaloneRedactor("secrets", { sourceEnv: process.env });
  return buildMcpListResult({
    defaultAllowlist: defaultIdsOf(registry),
    commandEntries: registry.commandEntries,
    ...(registry.toolingEntries === undefined ? {} : { toolingEntries: registry.toolingEntries }),
    allow: options.allow,
    deny: options.deny,
    tooling: options.tooling,
    diagnostics: [...(registry.diagnostics ?? []), ...pendingAllowanceDiagnostics(pending, redactor)],
  });
});

/**
 * Serve MCP over stdio until the transport closes (stdin EOF). Constructs
 * the MCP service layer lazily, computes the catalog for `tools/list`, and runs the
 * dispatch loop. Emits no command-result envelope on the protocol stream;
 * startup validation failures still surface as one failure envelope.
 */
export const serveMcp = Effect.fn("Mcp.serve")(function* (
  registry: McpCommandRegistry,
  flags: McpCommandFlags,
  apps: McpAppGenerations,
): Effect.fn.Return<void, McpToolInputError | McpTransportError, ConfigService | RedactionService> {
  const { options } = yield* resolveOptions(registry, flags);
  const runtimeConfig = buildMcpRuntimeConfig(
    {
      ...registry,
      // Session-wide owners only: plugin owners come from each call's app generation.
      commandEntries: registry.commandEntries.filter((entry) => entry.plugin === undefined),
    },
    apps,
  );
  const catalogOptions = {
    allow: options.allow,
    deny: options.deny,
    tooling: options.tooling,
  };
  yield* Effect.gen(function* () {
    const service = yield* McpService;
    yield* service
      .serve({
        transport: "stdio",
        cwd: process.cwd(),
        ...catalogOptions,
        ...(options.maxConcurrent === undefined ? {} : { maxConcurrent: options.maxConcurrent }),
      })
      .pipe(Effect.provide(RendererStdio.layer));
  }).pipe(
    Effect.scoped,
    Effect.provide(serviceLayer),
    Effect.provideService(McpRuntimeConfig, runtimeConfig),
  );
});

export const dispatchMcpCommand = async (params: {
  readonly flags: McpCommandFlags;
  readonly signal?: AbortSignal;
  readonly commandRuntime: Layer.Layer<
    ConfigService | RedactionService | BuiltInCommandCatalog,
    ConfigError | LandoRuntimeBootstrapError
  >;
  /** The retained host runtime and the per-app generation factory every tool call builds from. */
  readonly sessionRuntime: Result.Result<LandoGenerationRuntime, LandoRuntimeBootstrapError>;
  /** Runs before the tooling catalog is listed; the host rebuilds a non-fresh command index here. */
  readonly prepareTooling?: Effect.Effect<void>;
  readonly rendererMode: RendererMode;
  readonly resultFormat: ResultFormat;
  readonly invocation: CliInvocationSnapshot;
  readonly formatError: (
    failure: import("@lando/sdk/command-result").ProjectedFailure,
    redactor: import("@lando/sdk/secrets").Redactor,
  ) => string;
}): Promise<void> => {
  const prepareTooling = params.prepareTooling ?? Effect.void;
  if (params.flags.list === true) {
    const listEffect = Effect.gen(function* () {
      const catalog = yield* BuiltInCommandCatalog;
      const builtIns = mcpRegistryFromBuiltIns(catalog.entries);
      const tooling = yield* toolingEnabled(params.flags);
      const session = yield* openMcpSession(params.sessionRuntime, builtIns, prepareTooling);
      const registry = yield* sessionAppRegistry(builtIns, session, tooling);
      return yield* mcpListResult(registry, params.flags);
    }).pipe(Effect.scoped);
    // Lazy on purpose: a static import would pull compiled-session (and its
    // renderer plugin graph) into every consumer of this command module.
    const { activeJq, activeProjectResultKeys } = await import("../../compiled-session");
    const projectResultKeys = activeProjectResultKeys();
    const jqExpression = activeJq;
    return runWithRendererHandling(listEffect, {
      runtime: params.commandRuntime,
      rendererMode: params.rendererMode,
      resultFormat: params.resultFormat,
      ...(projectResultKeys === undefined ? {} : { projectResultKeys }),
      ...(jqExpression === undefined ? {} : { jqExpression }),
      command: "meta:mcp",
      invocation: params.invocation,
      resultSchema: McpListResultSchema,
      render: renderMcpListResult,
      formatError: params.formatError,
    });
  }

  const startupError = mcpServeStartupError(params.resultFormat);
  const serveEffect =
    startupError === undefined
      ? Effect.gen(function* () {
          const catalog = yield* BuiltInCommandCatalog;
          const builtIns = mcpRegistryFromBuiltIns(catalog.entries);
          const tooling = yield* toolingEnabled(params.flags);
          const session = yield* openMcpSession(params.sessionRuntime, builtIns, prepareTooling);
          // A session app that cannot build still serves built-ins; its calls report the failure.
          const sessionApp = yield* Effect.exit(sessionAppRegistry(builtIns, session, tooling));
          const registry = Exit.isSuccess(sessionApp) ? sessionApp.value : builtIns;
          yield* serveMcp(registry, params.flags, session.apps);
        }).pipe(Effect.scoped)
      : Effect.fail(startupError);
  const signal = params.signal;
  const interrupted =
    signal === undefined
      ? Effect.never
      : Effect.callback<never>((resume) => {
          const abort = () => resume(Effect.interrupt);
          if (signal.aborted) {
            abort();
            return;
          }
          signal.addEventListener("abort", abort, { once: true });
          return Effect.sync(() => signal.removeEventListener("abort", abort));
        });
  await runWithRendererHandling(Effect.raceFirst(interrupted, serveEffect), {
    runtime: params.commandRuntime,
    rendererMode: params.rendererMode,
    resultFormat: "text",
    command: "meta:mcp",
    invocation: params.invocation,
    resultSchema: McpListResultSchema,
    suppressInterruptionDiagnostics: true,
    render: () => undefined,
    formatError: params.formatError,
  });
  if (signal?.aborted && (process.exitCode === undefined || process.exitCode === 0)) {
    process.exitCode = signal.reason === "SIGTERM" ? 143 : 130;
  }
};
