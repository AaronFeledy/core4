/**
 * `LandoCommandBase` — the OCLIF Command subclass that adapts Effect into
 * OCLIF's `run()` lifecycle.
 *
 * The pattern:
 *
 * ```ts
 * export default class StartCommand extends LandoCommandBase {
 *   static description = "Start a Lando app";
 *   static landoSpec = startCommandSpec;  // LandoCommandSpec
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
 * Status: stub.
 */
import { Command } from "@oclif/core";

import type { Effect } from "effect";

/**
 * `LandoCommandSpec`.
 *
 * Every command, whether built-in or contributed by a plugin, conforms to
 * this shape. The OCLIF adapter compiles it into an OCLIF `Command`
 * subclass.
 */
export interface LandoCommandSpec<A = void, E = unknown> {
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly examples?: ReadonlyArray<string>;
  readonly hidden?: boolean;
  readonly bootstrap: "minimal" | "plugins" | "commands" | "tooling" | "provider" | "app";
  // TODO: typed flag/arg shapes. For now, generic.
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly run: (input: unknown) => Effect.Effect<A, E, unknown>;
}

/**
 * Base class for built-in commands. Plugin-contributed commands compile
 * to subclasses of this via `compileCommandSpec()` (TBD).
 */
export abstract class LandoCommandBase extends Command {
  /**
   * The Lando-specific spec backing this command. Subclasses set this as a
   * static field; the base reads it to drive bootstrap and Effect execution.
   */
  static landoSpec: LandoCommandSpec | undefined = undefined;

  /**
   * Run the underlying Effect program. Subclasses' `run()` should call this.
   *
   * TODO: wire argv → CommandInput → makeLandoRuntime →
   * Effect.runPromiseExit → exit code translation.
   */
  protected async runEffect<A, E>(_spec: LandoCommandSpec<A, E>): Promise<void> {
    throw new Error("LandoCommandBase.runEffect: not yet implemented");
  }
}
