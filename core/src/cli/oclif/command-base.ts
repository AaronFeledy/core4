import { Command } from "@oclif/core";

import { Cause, Effect, Exit, type Layer } from "effect";

import {
  LandoRuntimeBootstrapError,
  type NotImplementedError,
  RendererSelectionError,
} from "@lando/sdk/errors";

import type { BootstrapLevel } from "../../runtime/bootstrap.ts";
import { notImplementedErrorForCommand as deferredErrorForCommand } from "../deferred-commands.ts";
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
  "app:destroy",
  "app:exec",
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
  "meta:bun",
  "meta:config",
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
 * True for canonical namespace-prefixed Lando command ids (i.e. `app:*`,
 * `apps:*`, `meta:*`). Test fixtures and ad-hoc commands with non-canonical
 * ids fall outside this set and are not subject to the implemented-command
 * `NotImplementedError` guard in `runEffect`.
 */
export const isCanonicalLandoCommandId = (commandId: string): boolean => /^(app|apps|meta):/.test(commandId);

export const notImplementedErrorForCommand = (commandId: string): NotImplementedError =>
  deferredErrorForCommand(commandId);

const commandErrorMessage = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    const details: string[] = [error.message];
    const tag = "_tag" in error && typeof error._tag === "string" ? error._tag : undefined;
    if (tag === "LandofileParseError" && "filePath" in error && typeof error.filePath === "string")
      details.push(`filePath: ${error.filePath}`);
    if (tag === "LandofileParseError" && "line" in error && typeof error.line === "number")
      details.push(`line: ${error.line}`);
    if (tag === "NotImplementedError") details.unshift(tag);
    if (tag === "NotImplementedError" && "commandId" in error && typeof error.commandId === "string")
      details.push(`commandId: ${error.commandId}`);
    if (tag === "NotImplementedError" && "specSection" in error && typeof error.specSection === "string")
      details.push(`specSection: ${error.specSection}`);
    if (tag === "RendererSelectionError") details.unshift(tag);
    if (tag === "RendererSelectionError" && "value" in error && typeof error.value === "string")
      details.push(`value: ${error.value}`);
    if (tag === "RendererSelectionError" && "source" in error && typeof error.source === "string")
      details.push(`source: ${error.source}`);
    if ("remediation" in error && typeof error.remediation === "string") details.push(error.remediation);
    if (tag === "LandofileNotFoundError")
      details.push("Run `lando init --full --name=<name>` to scaffold an app.");
    return details.join("\n");
  }
  return String(error);
};

/** Extract the `AbortSignal` passed by `runEffect` into `spec.run({ argv, signal })`. */
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
   * Run the underlying Effect program. Subclasses' `run()` should call this.
   * The init hook owns runtime selection, and the base provides that runtime
   * to the command Effect.
   */
  protected async runEffect<A, E, R>(spec: LandoCommandSpec<A, E, R>): Promise<void> {
    let rendererMode: "lando" | "json" | "plain";
    try {
      const resolution = resolveRendererMode({
        argv: this.argv,
        env: process.env,
      });
      rendererMode = resolution.mode;
      this.argv.length = 0;
      this.argv.push(...resolution.remainingArgv);
    } catch (error) {
      if (error instanceof RendererSelectionError) {
        throw new Error(commandErrorMessage(error));
      }
      throw error;
    }

    if (isCanonicalLandoCommandId(spec.id) && !isMvpCommandId(spec.id)) {
      throw new Error(commandErrorMessage(notImplementedErrorForCommand(spec.id)));
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
    const exit = await Effect.runPromiseExit(
      Effect.provide(spec.run(input), runtime as Layer.Layer<R, LandoRuntimeBootstrapError>),
    ).finally(() => {
      process.off("SIGINT", abort);
      process.off("SIGTERM", abort);
    });

    if (Exit.isFailure(exit)) {
      const failure = Cause.failureOption(exit.cause);
      throw new Error(
        failure._tag === "Some" ? commandErrorMessage(failure.value) : Cause.pretty(exit.cause),
      );
    }

    const rendered = spec.render?.(exit.value, input);
    if (rendered !== undefined && rendered.length > 0) this.log(rendered);
  }
}
