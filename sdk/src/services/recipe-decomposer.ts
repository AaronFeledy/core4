import { Context, type Effect } from "effect";
import type { RecipeDecomposeError } from "../errors/recipe.ts";
import type { RecipeDecomposeInput, RecipeDecomposeResult } from "../schema/recipe-decompose.ts";
import type { Redactor } from "../secrets/index.ts";

export type * from "../schema/recipe-decompose.ts";

/**
 * Turns already-merged recipe options into the authoring data a user owns.
 *
 * A decomposer is a pure translation step. It performs no app-root detection,
 * no provider action, no filesystem write, no post-init work, no planning, and
 * it never executes arbitrary programmatic recipe code. Everything the recipe
 * selected is returned as authoring data; nothing is left for a later runtime
 * expansion to infer.
 *
 * Raw secret answers never reach `decompose`. The caller resolves each secret
 * prompt to an approved store reference or a named init-only sink before the
 * input is built, so a secret value cannot enter a template, provenance, a
 * diagnostic, or an emitted file through this port.
 */
export interface RecipeDecomposerShape {
  /** Versioned identity every result of this decomposer records as its producer. */
  readonly producer: RecipeDecomposeResult["provenance"]["producer"];
  /** Decompose merged nonsecret options into authoring data plus inert provenance. */
  readonly decompose: (
    input: RecipeDecomposeInput,
  ) => Effect.Effect<RecipeDecomposeResult, RecipeDecomposeError, never>;
}

/**
 * Ports a decomposer factory closes over. Injecting the redactor here is what
 * lets a decomposer report a secret-sink failure through central redaction
 * without reaching for an ambient service at call time.
 */
export interface RecipeDecomposerPorts {
  /** Central redactor applied to anything a failure would otherwise surface. */
  readonly redactor: Redactor;
}

/**
 * Factory shape a plugin publishes. The factory closes over explicitly injected
 * ports so `decompose` itself requires no Effect context.
 */
export type RecipeDecomposerFactory = (ports: RecipeDecomposerPorts) => RecipeDecomposerShape;

export class RecipeDecomposer extends Context.Tag("@lando/core/RecipeDecomposer")<
  RecipeDecomposer,
  RecipeDecomposerShape
>() {}
