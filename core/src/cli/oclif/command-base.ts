/**
 * `LandoCommandBase` — the OCLIF Command subclass that adapts Effect into
 * OCLIF's `run()` lifecycle.
 *
 * The pattern:
 *
 * ```ts
 * export default class StartCommand extends LandoCommandBase {
 *   static description = "Start a Lando app";
 *   static landoSpec = startCommandSpec;
 *   async run(): Promise<void> {
 *     await this.runEffect(startCommandSpec);
 *   }
 * }
 * ```
 *
 * The base class:
 *   1. Parses argv via OCLIF.
 *   2. Builds `CommandInput` (`stdin`/`stdout`/`stderr` as Stream/Sink).
 *   3. Reads the command's `bootstrap` level off the spec.
 *   4. Builds `LandoRuntimeLive` at that level via `makeLandoRuntime`.
 *   5. Runs `spec.run(input)` via `Effect.runPromiseExit` and translates
 *      tagged errors → OCLIF exit codes.
 *
 */
import { Command } from "@oclif/core";

import { Cause, Effect, Exit, type Layer } from "effect";

import { LandoRuntimeBootstrapError, NotImplementedError } from "@lando/sdk/errors";

import type { BootstrapLevel } from "../../runtime/bootstrap.ts";
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
  readonly render?: (result: unknown) => string | undefined;
}

const MVP_COMMAND_IDS = new Set([
  "app:destroy",
  "app:exec",
  "app:info",
  "app:shell",
  "app:ssh",
  "app:start",
  "app:stop",
  "apps:init",
  "meta:doctor",
  "meta:setup",
  "meta:shellenv",
  "meta:version",
]);

const SPEC_SECTION_BY_PREFIX: ReadonlyArray<readonly [string, string]> = [
  ["meta:plugin:", "spec/10-plugins.md"],
  ["meta:recipes:", "spec/17-executable-tutorials.md"],
  ["app:cache:", "spec/12-caches-and-persistence.md"],
  ["app:includes:", "spec/07-landofile-and-config.md"],
  ["app:config", "spec/07-landofile-and-config.md"],
  ["app:exec", "spec/08-cli-and-tooling.md"],
  ["app:shell", "spec/08-cli-and-tooling.md"],
  ["app:ssh", "spec/08-cli-and-tooling.md"],
  ["app:logs", "spec/08-cli-and-tooling.md"],
  ["meta:bun", "spec/08-cli-and-tooling.md"],
  ["meta:x", "spec/08-cli-and-tooling.md"],
];

export const isMvpCommandId = (commandId: string): boolean => MVP_COMMAND_IDS.has(commandId);

/**
 * True for canonical namespace-prefixed Lando command ids (i.e. `app:*`,
 * `apps:*`, `meta:*`). Test fixtures and ad-hoc commands with non-canonical
 * ids fall outside this set and are not subject to the MVP-only
 * `NotImplementedError` guard in `runEffect`.
 */
export const isCanonicalLandoCommandId = (commandId: string): boolean => /^(app|apps|meta):/.test(commandId);

export const specSectionForCommand = (commandId: string): string =>
  SPEC_SECTION_BY_PREFIX.find(([prefix]) => commandId.startsWith(prefix))?.[1] ??
  "spec/08-cli-and-tooling.md";

export const notImplementedErrorForCommand = (commandId: string): NotImplementedError => {
  const specSection = specSectionForCommand(commandId);
  return new NotImplementedError({
    message: `Command ${commandId} is not implemented in the MVP.`,
    commandId,
    specSection,
    remediation: `See ${specSection} for the command's owning specification and release phase.`,
  });
};

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
    if ("remediation" in error && typeof error.remediation === "string") details.push(error.remediation);
    if (tag === "LandofileNotFoundError")
      details.push("Run `lando init --full --name=<name>` to scaffold an app.");
    return details.join("\n");
  }
  return String(error);
};

/**
 * Resolve the OCLIF `aliases` array for a `LandoCommandSpec` from its
 * `topLevelAlias` rule. Returns the merged alias list,
 * including any explicit `aliases` already on the spec.
 */
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
    await this.parse(this.ctor);

    if (isCanonicalLandoCommandId(spec.id) && !isMvpCommandId(spec.id)) {
      throw new Error(commandErrorMessage(notImplementedErrorForCommand(spec.id)));
    }

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
    const exit = await Effect.runPromiseExit(
      Effect.provide(
        spec.run({ argv: this.argv, signal: controller.signal }),
        runtime as Layer.Layer<R, LandoRuntimeBootstrapError>,
      ),
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

    const rendered = spec.render?.(exit.value);
    if (rendered !== undefined && rendered.length > 0) this.log(rendered);
  }
}
