import { Schema } from "effect";

import { RendererActionId, RendererKeyChord } from "../schema/keymap.ts";

// ====
// KeymapConflictError — same-surface chord collision (§8.9.6).
// SPEC: spec/08-cli-and-tooling.md §8.9.6

/**
 * Raised by the post-decode keymap conflict check when two actions on the same
 * surface share a chord. Per-value chord failures remain ordinary ConfigError.
 */
export class KeymapConflictError extends Schema.TaggedError<KeymapConflictError>()("KeymapConflictError", {
  surface: Schema.Literal("task-tree", "prompt", "viewer", "keymap").annotations({
    description: "Input surface where the chord collision occurred.",
  }),
  chord: RendererKeyChord.annotations({
    description: "Shared chord that collides for two actions on the same surface.",
  }),
  actions: Schema.Tuple(RendererActionId, RendererActionId).annotations({
    description: "Deterministically sorted pair of colliding action ids.",
  }),
  message: Schema.String.annotations({
    description: "Human-readable description of the same-surface chord collision.",
  }),
  remediation: Schema.String.annotations({
    description: "Actionable guidance to remove or change one same-surface binding.",
  }),
}) {}
