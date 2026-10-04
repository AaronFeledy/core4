import { Schema } from "effect";

import { RendererActionId, RendererKeyChord } from "../schema/keymap.ts";

// ====
// KeymapConflictError — same-surface chord collision after KeymapConfig decode.

/**
 * Raised by the post-decode keymap conflict check when two actions on the same
 * surface share a chord. Per-value chord failures remain ordinary ConfigError.
 */
export class KeymapConflictError extends Schema.TaggedError<KeymapConflictError>()("KeymapConflictError", {
  surface: Schema.Literals(["task-tree", "prompt", "viewer", "keymap"]).annotate({
    description: "Input surface where the chord collision occurred.",
  }),
  chord: RendererKeyChord.annotate({
    description: "Shared chord that collides for two actions on the same surface.",
  }),
  actions: Schema.Tuple([RendererActionId, RendererActionId]).annotate({
    description: "Deterministically sorted pair of colliding action ids.",
  }),
  message: Schema.String.annotate({
    description: "Human-readable description of the same-surface chord collision.",
  }),
  remediation: Schema.String.annotate({
    description: "Actionable guidance to remove or change one same-surface binding.",
  }),
}) {}
