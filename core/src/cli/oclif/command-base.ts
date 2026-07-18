import { Command } from "@oclif/core";

import { Effect, Layer, Schema } from "effect";

import { LandoRuntimeBootstrapError, NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";
import type { DeprecationNotice, StreamFrameSchema } from "@lando/sdk/schema";
import type { EventService, Renderer } from "@lando/sdk/services";

import type { BootstrapLevel } from "../../runtime/bootstrap.ts";
import { type BugReportContext, type RendererMode, formatBugReport } from "../bug-report.ts";
import { newInvocationId } from "../command-lifecycle.ts";
import { normalizeScratchRunArgvForParsing } from "../commands/scratch-run.ts";
import { notImplementedErrorForCommand as deferredErrorForCommand } from "../deferred-commands.ts";
import { type ResultFormat, resolveResultFormat, universalFormatFlagDefs } from "../format-flags.ts";
import {
  type RenderContext,
  type StreamOutputFrame,
  resolveCliDeprecationWarnings,
  resolveCliRendererMode,
  runWithRendererHandling,
} from "../renderer-boundary.ts";
import { assertTopLevelAliasesClaimable } from "../reserved-aliases.ts";
import type { StreamFrameSink } from "../stream-frame-sink.ts";
import {
  preCommandOutputMode,
  renderCommandFlagValueValidation,
  renderPreCommandFailure,
} from "./command-boundary.ts";
import { getCommandRuntimeLayer } from "./hooks/init.ts";
import { assertHostProxyAllowlistSafe } from "./host-proxy-allowlist.ts";
import { assertMcpAllowlistSafe } from "./mcp-allowlist.ts";

/**
 * The three first-class command namespaces.
 *
 *   - `app`: operations on the current Lando app
 *   - `apps`: cross-app and host-discovery operations
 *   - `meta`: operations on Lando itself (config, plugins, host setup)
 */
export type LandoCommandNamespace = "app" | "apps" | "meta";

/**
 * Top-level alias rules.
 *
 *   - `false` (default): no top-level alias is registered.
 *   - `true`: register the canonical id with its namespace prefix stripped.
 *     `app:start` → `lando start`. `meta:plugin:add` → `lando plugin:add`.
 *   - `"name"`: register the given name as the top-level alias instead of
 *     the auto-derived name. Multi-segment values like `"plugin:add"` are
 *     accepted.
 *   - `{ name, deprecated }`: register an alias with its own deprecation notice.
 *   - `["a", { name, deprecated }]`: register multiple top-level aliases.
 */
export type LandoAliasSpec = string | { readonly name: string; readonly deprecated?: DeprecationNotice };
export type LandoTopLevelAlias = boolean | LandoAliasSpec | ReadonlyArray<LandoAliasSpec>;

const isAliasArray = (value: LandoTopLevelAlias): value is ReadonlyArray<LandoAliasSpec> =>
  Array.isArray(value);

export interface LandoCommandSpec<A = unknown, E = unknown, R = unknown> {
  /**
   * Canonical, namespace-prefixed command id (e.g. `"app:start"`,
   * `"meta:config"`). It starts with one of `LandoCommandNamespace` plus
   * `:`, and the canonical id is namespace-prefixed.
   */
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly namespace: LandoCommandNamespace;
  readonly deprecated?: DeprecationNotice;
  /** True only for commands exposed as MCP tools by default; destructive surfaces must not set this. */
  readonly mcpAllowed?: boolean;
  /** True only for commands safe to forward from inside a container via the in-container `lando` shim. */
  readonly hostProxyAllowed?: boolean;
  readonly topLevelAlias?: LandoTopLevelAlias;
  readonly aliases?: ReadonlyArray<LandoAliasSpec>;
  readonly examples?: ReadonlyArray<string>;
  readonly hidden?: boolean;
  readonly bootstrap:
    | "none"
    | "minimal"
    | "plugins"
    | "commands"
    | "tooling"
    | "provider"
    | "global"
    | "scratch"
    | "app";
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly run: (input: unknown) => Effect.Effect<A, E, R>;
  /** Required machine shape of this command's result; commands with no payload declare {@link EmptyResultSchema}. */
  readonly resultSchema: Schema.Schema.AnyNoContext;
  /** Present only for commands that stream incremental output (logs/exec/build). */
  readonly streaming?: StreamFrameSchema;
  readonly streamingMode?: "live";
  readonly streamFrames?: (result: unknown) => ReadonlyArray<StreamOutputFrame>;
  readonly redactionTokens?: (result: unknown) => ReadonlyArray<string>;
  readonly render?: (result: unknown, input?: unknown, ctx?: RenderContext) => string | undefined;
  readonly successExitCode?: {
    bivarianceHack(result: A, input?: unknown): number | undefined;
  }["bivarianceHack"];
  readonly suppressDeprecationDiagnostics?: (input: unknown) => boolean;
}

/** Result schema for a command with no machine-readable payload. */
export const EmptyResultSchema = Schema.Struct({});

/** Raised at registration when a command spec violates a structural rule (e.g. a missing `resultSchema`). */
export class CommandRegistrationError extends Schema.TaggedError<CommandRegistrationError>()(
  "CommandRegistrationError",
  {
    message: Schema.String,
    commandId: Schema.optional(Schema.String),
    remediation: Schema.optional(Schema.String),
  },
) {}

/** Reject a command spec that does not declare the required `resultSchema`. */
export const validateCommandSpec = (spec: {
  readonly id: string;
  readonly resultSchema?: unknown;
  readonly mcpAllowed?: boolean;
  readonly hostProxyAllowed?: boolean;
  readonly topLevelAlias?: LandoTopLevelAlias;
  readonly aliases?: ReadonlyArray<LandoAliasSpec>;
}): void => {
  if (spec.resultSchema === undefined || spec.resultSchema === null) {
    throw new CommandRegistrationError({
      message: `Command ${spec.id} does not declare a resultSchema. Every command must declare the machine-readable shape of its result; use EmptyResultSchema for a command with no payload.`,
      commandId: spec.id,
      remediation: "Add a `resultSchema` to the command spec.",
    });
  }
  assertMcpAllowlistSafe(spec);
  assertHostProxyAllowlistSafe(spec);
  assertTopLevelAliasesClaimable(
    spec.id,
    resolveTopLevelAliases({
      id: spec.id,
      ...(spec.topLevelAlias === undefined ? {} : { topLevelAlias: spec.topLevelAlias }),
      ...(spec.aliases === undefined ? {} : { aliases: spec.aliases }),
    }),
  );
};

const MVP_COMMAND_IDS = new Set([
  "app:cache:refresh",
  "app:config",
  "app:config:lint",
  "app:config:translate",
  "app:config:set",
  "app:config:unset",
  "app:config:edit",
  "app:config:validate",
  "app:destroy",
  "app:exec",
  "app:includes:update",
  "app:includes:verify",
  "app:info",
  "app:logs",
  "app:open",
  "app:pull",
  "app:push",
  "app:remote:add",
  "app:remote:env:list",
  "app:remote:list",
  "app:remote:remove",
  "app:remote:setup",
  "app:remote:test",
  "app:share",
  "app:share:list",
  "app:share:stop",
  "app:rebuild",
  "app:restart",
  "app:shell",
  "app:ssh",
  "app:start",
  "app:stop",
  "apps:init",
  "apps:list",
  "apps:poweroff",
  "apps:scratch:destroy",
  "apps:scratch:gc",
  "apps:scratch:info",
  "apps:scratch:list",
  "apps:scratch:logs",
  "apps:scratch:run",
  "apps:scratch:start",
  "apps:scratch:stop",
  "meta:bun",
  "meta:config",
  "meta:global:config",
  "meta:global:config:set",
  "meta:global:config:unset",
  "meta:global:config:edit",
  "meta:global:config:validate",
  "meta:global:destroy",
  "meta:global:info",
  "meta:global:install",
  "meta:global:list",
  "meta:global:logs",
  "meta:global:rebuild",
  "meta:global:restart",
  "meta:global:start",
  "meta:global:status",
  "meta:global:stop",
  "meta:global:uninstall",
  "meta:doctor",
  "meta:recipes:list",
  "meta:recipes:describe",
  "meta:recipes:validate",
  "meta:mcp",
  "meta:plugin:add",
  "meta:plugin:build",
  "meta:plugin:link",
  "meta:plugin:unlink",
  "meta:plugin:new",
  "meta:plugin:publish",
  "meta:plugin:remove",
  "meta:plugin:test",
  "meta:plugin:trust",
  "meta:plugin:trust-authoring-root",
  "meta:setup",
  "meta:shellenv",
  "meta:uninstall",
  "meta:update",
  "meta:version",
  "meta:x",
]);

export const isMvpCommandId = (commandId: string): boolean => MVP_COMMAND_IDS.has(commandId);

/**
 * True for canonical namespace-prefixed Lando command ids (`app:*`,
 * `apps:*`, `meta:*`).
 */
export const isCanonicalLandoCommandId = (commandId: string): boolean => /^(app|apps|meta):/.test(commandId);

export const notImplementedErrorForCommand = (commandId: string): NotImplementedError =>
  deferredErrorForCommand(commandId);

export const formatCommandError = (input: {
  readonly error: unknown;
  readonly commandId: string;
  readonly rendererMode: RendererMode;
}): string => {
  const context: BugReportContext = { commandId: input.commandId };
  return formatBugReport({ error: input.error, context, rendererMode: input.rendererMode });
};

export const extractSpecAbortSignal = (input: unknown): AbortSignal | undefined =>
  typeof input === "object" && input !== null && "signal" in input && input.signal instanceof AbortSignal
    ? input.signal
    : undefined;

export const resolveTopLevelAliases = (
  spec: Pick<LandoCommandSpec, "id" | "topLevelAlias" | "aliases">,
): ReadonlyArray<string> => {
  const explicit = (spec.aliases ?? []).map((alias) => (typeof alias === "string" ? alias : alias.name));
  const top = spec.topLevelAlias;

  if (top === false || top === undefined) {
    return explicit;
  }

  if (top === true) {
    const stripped = spec.id.replace(/^[^:]+:/, "");
    return Array.from(new Set([...explicit, stripped]));
  }

  if (typeof top === "string") {
    return Array.from(new Set([...explicit, top]));
  }

  if (!isAliasArray(top)) {
    return Array.from(new Set([...explicit, top.name]));
  }

  return Array.from(
    new Set([...explicit, ...top.map((alias) => (typeof alias === "string" ? alias : alias.name))]),
  );
};

/**
 * Base class for built-in commands. Plugin-contributed commands compile
 * to subclasses of this via `compileCommandSpec()`.
 */
export abstract class LandoCommandBase extends Command {
  static override baseFlags = universalFormatFlagDefs;

  /**
   * The Lando-specific spec backing this command. Subclasses set this as a
   * static field; the base reads it to drive bootstrap and Effect execution.
   */
  static landoSpec: LandoCommandSpec | undefined = undefined;

  /** Bootstrap depth required before this command can run. */
  static bootstrap: BootstrapLevel | undefined = undefined;

  /**
   * Run the underlying Effect program for this command. Subclasses' `run()`
   * should call this.
   * The init hook owns runtime selection, and the base provides that runtime
   * to the command Effect.
   */
  protected async runEffect<A, E, R>(spec: LandoCommandSpec<A, E, R>): Promise<void> {
    validateCommandSpec(spec);
    if (spec.id === "apps:scratch:run") {
      const normalizedArgv = normalizeScratchRunArgvForParsing(this.argv);
      this.argv.length = 0;
      this.argv.push(...normalizedArgv);
    }

    let rendererMode: RendererMode;
    try {
      const resolution = await resolveCliRendererMode({
        argv: this.argv,
        env: process.env,
      });
      rendererMode = resolution.mode;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        await renderPreCommandFailure({
          commandId: "cli:renderer-selection",
          error,
          ...preCommandOutputMode({ argv: this.argv, env: process.env }),
        });
        return;
      }
      throw error;
    }

    const deprecationWarnings = resolveCliDeprecationWarnings({ argv: this.argv, env: process.env });
    this.argv.length = 0;
    this.argv.push(...deprecationWarnings.remainingArgv);

    let resultFormat: ResultFormat = "text";
    try {
      const resolution = resolveResultFormat({ argv: this.argv, rendererMode });
      resultFormat = resolution.format;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError) {
        await renderPreCommandFailure({
          commandId: "cli:format-selection",
          error,
          rendererMode,
          resultFormat: rendererMode === "json" ? "json" : "text",
        });
        return;
      }
      throw error;
    }

    if (
      await renderCommandFlagValueValidation({
        commandId: spec.id,
        argv: this.argv,
        definitions: { ...this.ctor.baseFlags, ...this.ctor.flags },
        rendererMode,
        resultFormat,
        resultSchema: spec.resultSchema,
        deprecationWarnings: deprecationWarnings.enabled,
        allowUnknownFlags: this.ctor.strict === false,
      })
    )
      return;

    if (isCanonicalLandoCommandId(spec.id) && !isMvpCommandId(spec.id)) {
      const error = notImplementedErrorForCommand(spec.id);
      const text = formatCommandError({
        error,
        commandId: spec.id,
        rendererMode,
      });
      if (resultFormat === "json") {
        await runWithRendererHandling(Effect.fail(error), {
          runtime: Layer.empty,
          rendererMode,
          resultFormat,
          command: spec.id,
          resultSchema: spec.resultSchema,
          ...(spec.streaming === undefined ? {} : { streaming: spec.streaming }),
          ...(spec.streamFrames === undefined ? {} : { streamFrames: spec.streamFrames }),
          deprecationWarnings: deprecationWarnings.enabled,
          formatError: (failure) =>
            formatCommandError({
              error: failure,
              commandId: spec.id,
              rendererMode,
            }),
        });
        return;
      }
      throw new Error(text);
    }

    const parsed = await this.parse(this.ctor);

    const runtime = getCommandRuntimeLayer(this.ctor);
    if (runtime === undefined) {
      await renderPreCommandFailure({
        commandId: spec.id,
        error: new LandoRuntimeBootstrapError({
          message: `OCLIF command ${this.id ?? spec.id} is missing a valid static bootstrap declaration.`,
          stage: "minimal",
        }),
        rendererMode,
        resultFormat,
        resultSchema: spec.resultSchema,
        failureExitCode: 1,
        deprecationWarnings: deprecationWarnings.enabled,
      });
      return;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const input = {
      argv: this.argv,
      parsedArgv: (parsed as { readonly argv?: ReadonlyArray<string> }).argv ?? [],
      signal: controller.signal,
      flags: (parsed as { flags?: Record<string, unknown> }).flags ?? {},
      args: (parsed as { args?: Record<string, unknown> }).args ?? {},
      rendererMode,
    };
    const flags = input.flags as Record<string, unknown>;
    flags.format = resultFormat;
    if (resultFormat === "json") flags.json = true;
    await runWithRendererHandling(spec.run(input), {
      runtime: runtime as Layer.Layer<
        Exclude<R, EventService | Renderer | StreamFrameSink>,
        LandoRuntimeBootstrapError
      >,
      rendererMode,
      resultFormat,
      command: spec.id,
      invocation: {
        commandId: spec.id,
        argv: input.argv,
        args: input.args,
        flags: input.flags,
        cwd: process.cwd(),
        invocationId: newInvocationId(),
      },
      resultSchema: spec.resultSchema,
      ...(spec.streaming === undefined ? {} : { streaming: spec.streaming }),
      ...(spec.streamingMode === undefined ? {} : { streamingMode: spec.streamingMode }),
      ...(spec.streamFrames === undefined ? {} : { streamFrames: spec.streamFrames }),
      ...(spec.redactionTokens === undefined ? {} : { redactionTokens: spec.redactionTokens }),
      deprecationWarnings: deprecationWarnings.enabled,
      suppressDeprecationDiagnostics: spec.suppressDeprecationDiagnostics?.(input) === true,
      render: (value, ctx) => spec.render?.(value, input, ctx),
      ...(spec.successExitCode === undefined
        ? {}
        : { successExitCode: (value) => spec.successExitCode?.(value, input) }),
      formatError: (error) =>
        formatCommandError({
          error,
          commandId: spec.id,
          rendererMode,
        }),
    }).finally(() => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    });
  }
}
