import { Command } from "@oclif/core";

import { Effect, type Layer } from "effect";

import { LandoRuntimeBootstrapError, NotImplementedError, RendererSelectionError } from "@lando/sdk/errors";
import type { Renderer } from "@lando/sdk/services";

import type { BootstrapLevel } from "../../runtime/bootstrap.ts";
import { type BugReportContext, type RendererMode, formatBugReport } from "../bug-report.ts";
import { notImplementedErrorForCommand as deferredErrorForCommand } from "../deferred-commands.ts";
import {
  makeRendererServiceLiveForMode,
  runWithRendererHandling,
  writeDiagnosticLine,
} from "../renderer-boundary.ts";
import { resolveRendererMode } from "../renderer-selection.ts";
import { getCommandRuntimeLayer } from "./hooks/init.ts";

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
 *   - `["a", "b"]`: register multiple top-level aliases.
 */
export type LandoTopLevelAlias = boolean | string | ReadonlyArray<string>;

export interface LandoCommandSpec<A = void, E = unknown, R = unknown> {
  /**
   * Canonical, namespace-prefixed command id (e.g. `"app:start"`,
   * `"meta:config"`). MUST start with one of `LandoCommandNamespace` plus
   * `:`. The canonical id MUST be namespace-prefixed.
   */
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly namespace: LandoCommandNamespace;
  readonly topLevelAlias?: LandoTopLevelAlias;
  readonly aliases?: ReadonlyArray<string>;
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
  readonly render?: (result: unknown, input?: unknown) => string | undefined;
}

const MVP_COMMAND_IDS = new Set([
  "app:cache:refresh",
  "app:config",
  "app:config:lint",
  "app:destroy",
  "app:exec",
  "app:includes:update",
  "app:includes:verify",
  "app:info",
  "app:logs",
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
  "apps:scratch:start",
  "apps:scratch:stop",
  "meta:bun",
  "meta:config",
  "meta:global:config",
  "meta:global:destroy",
  "meta:global:install",
  "meta:global:start",
  "meta:global:status",
  "meta:global:stop",
  "meta:global:uninstall",
  "meta:doctor",
  "meta:plugin:add",
  "meta:plugin:remove",
  "meta:setup",
  "meta:shellenv",
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

const formatCommandError = (input: {
  readonly error: unknown;
  readonly commandId: string;
  readonly rendererMode: RendererMode;
}): string => {
  const context: BugReportContext = { commandId: input.commandId };
  return formatBugReport({ error: input.error, context, rendererMode: input.rendererMode });
};

const formatRendererSelectionError = (error: unknown): string =>
  formatBugReport({
    error,
    context: { commandId: "cli:renderer-selection" },
    rendererMode: "plain",
  });

/** Extract the `AbortSignal` passed into the command Effect. */
export const extractSpecAbortSignal = (input: unknown): AbortSignal | undefined =>
  typeof input === "object" && input !== null && "signal" in input && input.signal instanceof AbortSignal
    ? input.signal
    : undefined;

/** Resolve the OCLIF `aliases` array from `topLevelAlias` and any explicit aliases. */
export const resolveTopLevelAliases = (spec: LandoCommandSpec): ReadonlyArray<string> => {
  const explicit = spec.aliases ?? [];
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

  return Array.from(new Set([...explicit, ...top]));
};

/**
 * Base class for built-in commands. Plugin-contributed commands compile
 * to subclasses of this via `compileCommandSpec()`.
 */
export abstract class LandoCommandBase extends Command {
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
    let rendererMode: RendererMode;
    try {
      const resolution = resolveRendererMode({
        argv: this.argv,
        env: process.env,
      });
      rendererMode = resolution.mode;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError || error instanceof NotImplementedError) {
        throw new Error(formatRendererSelectionError(error));
      }
      throw error;
    }

    if (isCanonicalLandoCommandId(spec.id) && !isMvpCommandId(spec.id)) {
      const text = formatCommandError({
        error: notImplementedErrorForCommand(spec.id),
        commandId: spec.id,
        rendererMode,
      });
      if (rendererMode === "json") {
        await Effect.runPromise(
          writeDiagnosticLine(text).pipe(Effect.provide(makeRendererServiceLiveForMode(rendererMode))),
        );
        process.exitCode = 1;
        return;
      }
      throw new Error(text);
    }

    const parsed = await this.parse(this.ctor);

    const runtime = getCommandRuntimeLayer(this.ctor);
    if (runtime === undefined) {
      throw new LandoRuntimeBootstrapError({
        message: `OCLIF command ${this.id ?? spec.id} is missing a valid static bootstrap declaration.`,
        stage: "minimal",
      });
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    process.once("SIGINT", abort);
    process.once("SIGTERM", abort);
    const input = {
      argv: this.argv,
      signal: controller.signal,
      flags: (parsed as { flags?: Record<string, unknown> }).flags ?? {},
      args: (parsed as { args?: Record<string, unknown> }).args ?? {},
      rendererMode,
    };
    await runWithRendererHandling(spec.run(input), {
      runtime: runtime as Layer.Layer<Exclude<R, Renderer>, LandoRuntimeBootstrapError>,
      rendererMode,
      render: (value) => spec.render?.(value, input),
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
