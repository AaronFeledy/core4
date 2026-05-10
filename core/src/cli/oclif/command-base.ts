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
/**
 * The three first-class command namespaces (SPEC: §8.1.1).
 *
 *   - `app`: operations on the current Lando app
 *   - `apps`: cross-app and host-discovery operations
 *   - `meta`: operations on Lando itself (config, plugins, host setup)
 */
export type LandoCommandNamespace = "app" | "apps" | "meta";

/**
 * Top-level alias rules (SPEC: §8.1.2).
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

export interface LandoCommandSpec<A = void, E = unknown> {
  /**
   * Canonical, namespace-prefixed command id (e.g. `"app:start"`,
   * `"meta:config"`). MUST start with one of `LandoCommandNamespace` plus
   * `:`. SPEC: §8.1.1.
   */
  readonly id: string;
  readonly summary: string;
  readonly description?: string;
  readonly namespace: LandoCommandNamespace;
  readonly topLevelAlias?: LandoTopLevelAlias;
  readonly aliases?: ReadonlyArray<string>;
  readonly examples?: ReadonlyArray<string>;
  readonly hidden?: boolean;
  readonly bootstrap: "none" | "minimal" | "plugins" | "commands" | "tooling" | "provider" | "app";
  // TODO: typed flag/arg shapes. For now, generic.
  readonly flags?: Readonly<Record<string, unknown>>;
  readonly args?: Readonly<Record<string, unknown>>;
  readonly run: (input: unknown) => Effect.Effect<A, E, unknown>;
}

/**
 * Resolve the OCLIF `aliases` array for a `LandoCommandSpec` from its
 * `topLevelAlias` rule (SPEC: §8.1.2). Returns the merged alias list,
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
