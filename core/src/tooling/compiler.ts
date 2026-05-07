/**
 * Tooling compilation pipeline.
 *
 *   Landofile tooling entry
 *     → schema validation (Effect Schema)
 *     → service + flag resolution
 *     → engine selection
 *     → engine.compile(spec) → ToolingProgram
 *     → OCLIF command spec generation
 *     → command cache write
 *     → on invocation: OCLIF parses argv → engine.execute(program, input)
 *
 * **Hot path:** the compiled `ToolingProgram` is stored in the
 * app plan cache. On invocation at bootstrap level `tooling`:
 *   1. Read the cached `ToolingProgram` from `CacheService`.
 *   2. Parse argv with OCLIF using the cached flag/arg specs.
 *   3. Build `LandoRuntimeLive` at level `provider` (skip `app`).
 *   4. Run `engine.execute(program, input)` and propagate exit code.
 *
 * Status: stub.
 */
import type { Effect } from "effect";

import type { ToolingCompileError } from "@lando/sdk/errors";

import type { ToolingSpec } from "./schema.ts";

/**
 * `ToolingProgram` — the engine-specific compiled form of a tooling spec.
 * Provider-neutral but engine-private; consumers get back an opaque program.
 */
export interface ToolingProgram {
  readonly engineId: string;
  readonly toolName: string;
  // Engine-private fields go here; the schema is engine-defined.
  readonly compiled: unknown;
}

export const compileTooling = (
  _toolName: string,
  _spec: ToolingSpec,
): Effect.Effect<ToolingProgram, ToolingCompileError> => {
  throw new Error("compileTooling: not yet implemented");
};
