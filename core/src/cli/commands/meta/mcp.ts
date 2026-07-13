/**
 * `meta:mcp` (`lando mcp`) command logic.
 *
 * Two modes share one option/validation core:
 *   - `--list` projects the effective tool catalog (id, summary, source of
 *     allowance) as a normal machine-output result (`McpListResult`).
 *   - serve mode runs the long-running stdio MCP server: it constructs
 *     `McpServiceLive` lazily, drives `McpService.serve` over the hand-rolled
 *     stdio JSON-RPC transport, and emits NO command-result envelope so it
 *     never corrupts the MCP protocol stream (serve mode skips command-result envelopes).
 *
 * The command registry is injected (never imported from `compiled-commands`
 * here) so this module stays out of the compiled command-graph import cycle.
 */
import { Cause, Effect, Exit, Layer, Schema } from "effect";

import type { ConfigError, LandoRuntimeBootstrapError } from "@lando/sdk/errors";
import { McpToolInputError, type McpTransportError } from "@lando/sdk/errors";
import type { McpConfig } from "@lando/sdk/schema";
import { CommandRegistry, ConfigService } from "@lando/sdk/services";

import type { McpCommandEntry } from "../../../mcp/registry.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../../mcp/service.ts";
import { makeStdioMcpTransport } from "../../../mcp/stdio-transport.ts";
import { McpTransport } from "../../../mcp/transport.ts";
import type { RedactionService } from "../../../redaction/service.ts";
import type { RendererMode } from "../../bug-report.ts";
import type { ResultFormat } from "../../format-flags.ts";
import type { LandoCommandSpec } from "../../oclif/command-base.ts";
import { appConfigMcpSpecs } from "../../oclif/commands/app/config/index.ts";
import { MCP_DEFAULT_ALLOWLIST } from "../../oclif/generated/mcp-allowlist.ts";
import { assertMcpAllowlistSafe, isAppConfigMcpUnsafeId } from "../../oclif/mcp-allowlist.ts";
import { runWithRendererHandling } from "../../renderer-boundary.ts";
import { type RunToolingResult, renderRunToolingResult, runTooling } from "../tooling.ts";
import {
  type McpListResult,
  McpListResultSchema,
  buildMcpListResult,
  renderMcpListResult,
} from "./mcp-list.ts";

/** Flag inputs parsed from `lando mcp` (`--allow`/`--deny` repeatable, `--tooling`, `--list`). */
export interface McpCommandFlags {
  readonly allow?: ReadonlyArray<string> | undefined;
  readonly deny?: ReadonlyArray<string> | undefined;
  readonly tooling?: boolean | undefined;
  readonly list?: boolean | undefined;
}

/** Effective exposure options after composing flags with global `mcp.*` config. */
export interface ResolvedMcpOptions {
  readonly allow: ReadonlyArray<string>;
  readonly deny: ReadonlyArray<string>;
  readonly tooling: boolean;
}

/** The injected command registry the catalog + dispatch project from. */
export interface McpCommandRegistry {
  readonly commandEntries: ReadonlyArray<McpCommandEntry>;
  readonly toolingEntries?: ReadonlyArray<McpCommandEntry> | undefined;
}

interface RegisteredToolingCommand {
  readonly id: string;
  readonly summary: string;
  readonly hidden: boolean;
}

const ToolingMcpResultSchema = Schema.Struct({
  tool: Schema.String,
  service: Schema.String,
  exitCode: Schema.Number,
  stdout: Schema.String,
  stderr: Schema.String,
  rendered: Schema.optional(Schema.Boolean),
});

const toolingArgsFromInput = (input: unknown): ReadonlyArray<string> => {
  if (input === null || typeof input !== "object") return [];
  const args = (input as { readonly args?: Record<string, unknown> }).args;
  const values = args?.args;
  return Array.isArray(values) ? values.filter((value): value is string => typeof value === "string") : [];
};

const toolingSpecFromRegistered = (command: RegisteredToolingCommand): LandoCommandSpec => ({
  id: command.id,
  summary: command.summary,
  namespace: command.id.startsWith("meta:") ? "meta" : command.id.startsWith("apps:") ? "apps" : "app",
  bootstrap: "app",
  hidden: command.hidden,
  args: {
    args: {
      type: "string",
      multiple: true,
      description: "Arguments passed to the tooling task.",
    },
  },
  resultSchema: ToolingMcpResultSchema,
  run: (input) => runTooling({ name: command.id, args: toolingArgsFromInput(input), renderProgress: true }),
  render: (result) => renderRunToolingResult(result as RunToolingResult),
});

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

export const mcpRegistryFromCompiled = (
  compiled: Record<string, { readonly landoSpec?: LandoCommandSpec }>,
): McpCommandRegistry => ({
  commandEntries: Object.values(compiled).flatMap((command) => {
    const spec = command.landoSpec;
    if (spec === undefined) return [];
    assertMcpAllowlistSafe(spec);
    if (isAppConfigMcpUnsafeId(spec.id) && spec.id !== "app:config") return [];
    if (spec.id === "app:config") return appConfigMcpSpecs.map((projection) => ({ spec: projection }));
    return [{ spec }];
  }),
});

export const mcpRegistryWithToolingEntries = (
  registry: McpCommandRegistry,
  commands: ReadonlyArray<RegisteredToolingCommand>,
): McpCommandRegistry => ({
  commandEntries: registry.commandEntries,
  toolingEntries: commands
    .filter((command) => !command.hidden)
    .map((command) => ({ spec: toolingSpecFromRegistered(command), tooling: true })),
});

const resolveToolingRegistry = (
  registry: McpCommandRegistry,
  runtimeLayer: Layer.Layer<unknown>,
): Effect.Effect<McpCommandRegistry, never, never> =>
  Effect.scoped(
    Layer.build(runtimeLayer).pipe(
      Effect.orDie,
      Effect.flatMap((context) =>
        Effect.flatMap(CommandRegistry, (commandRegistry) => commandRegistry.list).pipe(
          Effect.provide(context),
        ),
      ),
      Effect.map((commands) => mcpRegistryWithToolingEntries(registry, commands)),
    ),
  );

const resolveRegistryForEffectiveOptions = (
  registry: McpCommandRegistry,
  options: ResolvedMcpOptions,
  runtimeLayer: Layer.Layer<unknown>,
): Effect.Effect<McpCommandRegistry, never, never> =>
  options.tooling === true ? resolveToolingRegistry(registry, runtimeLayer) : Effect.succeed(registry);

const resolveRegistryForCommand = (
  registry: McpCommandRegistry,
  flags: McpCommandFlags,
  runtimeLayer: Layer.Layer<unknown>,
): Effect.Effect<McpCommandRegistry, ConfigError | McpToolInputError, ConfigService> =>
  Effect.gen(function* () {
    const config = yield* Effect.flatMap(ConfigService, (service) => service.get("mcp"));
    const options = resolveMcpOptions(flags, config);
    return yield* resolveRegistryForEffectiveOptions(registry, options, runtimeLayer);
  });

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
});

const knownIdsOf = (registry: McpCommandRegistry): ReadonlySet<string> =>
  new Set([
    ...registry.commandEntries.map((entry) => entry.spec.id),
    ...(registry.toolingEntries ?? []).map((entry) => entry.spec.id),
  ]);

/**
 * Reject an unknown canonical id in `--allow` (or global `mcp.allow`) BEFORE
 * opening the transport, so serve startup fails deterministically with one
 * schema-valid failure envelope and no protocol frame. `--list` fails the same
 * way. `deny` is subtractive: an id outside the active registry is harmless and
 * may name tooling that is intentionally disabled for this invocation.
 */
export const validateMcpAllowlistIds = (
  options: ResolvedMcpOptions,
  knownIds: ReadonlySet<string>,
): Effect.Effect<void, McpToolInputError> => {
  for (const id of options.allow) {
    if (!knownIds.has(id)) {
      return Effect.fail(
        new McpToolInputError({
          message: `Unknown command id "${id}" in mcp.allow.`,
          toolId: id,
          path: "flags.allow",
          remediation: "Use a canonical Lando command id; run `lando mcp --list` to see available ids.",
        }),
      );
    }
  }
  return Effect.void;
};

const resolveOptions = (
  registry: McpCommandRegistry,
  flags: McpCommandFlags,
): Effect.Effect<ResolvedMcpOptions, ConfigError | McpToolInputError, ConfigService> =>
  Effect.gen(function* () {
    const config = yield* Effect.flatMap(ConfigService, (service) => service.get("mcp"));
    const options = resolveMcpOptions(flags, config);
    yield* validateMcpAllowlistIds(options, knownIdsOf(registry));
    return options;
  });

/** Build the retained-runtime config seam from the injected registry + runtime layer. */
export const buildMcpRuntimeConfig = (
  registry: McpCommandRegistry,
  runtimeLayer: Layer.Layer<unknown>,
): McpRuntimeConfigShape => ({
  commandEntries: registry.commandEntries,
  ...(registry.toolingEntries === undefined ? {} : { toolingEntries: registry.toolingEntries }),
  defaultAllowlist: MCP_DEFAULT_ALLOWLIST,
  runtimeLayer,
});

/**
 * The `--list` result: the effective tool catalog projected as an audit shape
 * (id, summary, source of allowance). A normal machine-output command result.
 */
export const mcpListResult = (
  registry: McpCommandRegistry,
  flags: McpCommandFlags,
): Effect.Effect<McpListResult, ConfigError | McpToolInputError, ConfigService> =>
  Effect.gen(function* () {
    const options = yield* resolveOptions(registry, flags);
    return buildMcpListResult({
      defaultAllowlist: MCP_DEFAULT_ALLOWLIST,
      commandEntries: registry.commandEntries,
      ...(registry.toolingEntries === undefined ? {} : { toolingEntries: registry.toolingEntries }),
      allow: options.allow,
      deny: options.deny,
      tooling: options.tooling,
    });
  });

/**
 * Serve MCP over stdio until the transport closes (stdin EOF). Constructs
 * `McpServiceLive` lazily, computes the catalog for `tools/list`, and runs the
 * dispatch loop. Emits no command-result envelope on the protocol stream;
 * startup validation failures still surface as one failure envelope.
 */
export const serveMcp = (
  registry: McpCommandRegistry,
  flags: McpCommandFlags,
  runtimeLayer: Layer.Layer<unknown>,
): Effect.Effect<
  void,
  ConfigError | McpToolInputError | McpTransportError,
  ConfigService | RedactionService
> =>
  Effect.gen(function* () {
    const options = yield* resolveOptions(registry, flags);
    const runtimeConfig = buildMcpRuntimeConfig(registry, runtimeLayer);
    const catalogOptions = {
      allow: options.allow,
      deny: options.deny,
      tooling: options.tooling,
    };
    yield* Effect.gen(function* () {
      const service = yield* McpService;
      const catalog = yield* service.catalog(catalogOptions);
      const transport = yield* makeStdioMcpTransport({ catalog });
      yield* service
        .serve({ transport: "stdio", ...catalogOptions })
        .pipe(Effect.provideService(McpTransport, transport));
    }).pipe(
      Effect.scoped,
      Effect.provide(McpServiceLive),
      Effect.provideService(McpRuntimeConfig, runtimeConfig),
    );
  });

export const dispatchMcpCommand = async (params: {
  readonly registry: McpCommandRegistry;
  readonly flags: McpCommandFlags;
  readonly commandRuntime: Layer.Layer<ConfigService | RedactionService, LandoRuntimeBootstrapError>;
  readonly retainedRuntime: Layer.Layer<unknown>;
  readonly rendererMode: RendererMode;
  readonly resultFormat: ResultFormat;
  readonly formatError: (error: unknown) => string;
}): Promise<void> => {
  if (params.flags.list === true) {
    const listEffect = Effect.gen(function* () {
      const registry = yield* resolveRegistryForCommand(
        params.registry,
        params.flags,
        params.retainedRuntime,
      );
      return yield* mcpListResult(registry, params.flags);
    });
    return runWithRendererHandling(listEffect, {
      runtime: params.commandRuntime,
      rendererMode: params.rendererMode,
      resultFormat: params.resultFormat,
      command: "meta:mcp",
      resultSchema: McpListResultSchema,
      render: (value, ctx) => renderMcpListResult(value, ctx),
      formatError: params.formatError,
    });
  }

  const exit = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const registry = yield* resolveRegistryForCommand(
        params.registry,
        params.flags,
        params.retainedRuntime,
      );
      yield* serveMcp(registry, params.flags, params.retainedRuntime);
    }).pipe(Effect.provide(params.commandRuntime)),
  );
  if (Exit.isSuccess(exit)) return;
  if (Exit.isInterrupted(exit)) return;

  const squashedError = Cause.squash(exit.cause);
  return runWithRendererHandling(Effect.fail(squashedError), {
    runtime: Layer.empty,
    rendererMode: params.rendererMode,
    resultFormat: params.resultFormat,
    command: "meta:mcp",
    resultSchema: McpListResultSchema,
    formatError: params.formatError,
  });
};
