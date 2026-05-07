/**
 * Tooling-command runner — `runTooling(name, input)`.
 *
 * Tooling commands (Landofile-defined) are accessed via this function. It
 * compiles and executes a `ToolingProgram` at bootstrap level `tooling` —
 * the hot path.
 */
import type { Effect } from "effect";

import type { ToolingCompileError, ToolingExecError } from "@lando/sdk/errors";

export interface RunToolingOptions {
  /** Tooling command name (the Landofile `tooling.<name>` key). */
  readonly name: string;
  /** Pass-through CLI arguments. */
  readonly args?: ReadonlyArray<string>;
  /** Per-invocation flag overrides. */
  readonly flags?: Readonly<Record<string, unknown>>;
}

export interface RunToolingResult {
  readonly tool: string;
  readonly exitCode: number;
}

export const runTooling = (
  _options: RunToolingOptions,
): Effect.Effect<RunToolingResult, ToolingCompileError | ToolingExecError, never> => {
  throw new Error("runTooling: not yet implemented");
};
