import { Schema } from "effect";

// ====
// RendererCapabilities — the sole public, renderer-neutral capability surface.
// SPEC: §8.9

/**
 * Boolean capability snapshot every renderer publishes. Owned exclusively by the
 * resolved `Renderer`; no other service or command infers capabilities.
 *
 * Fields default to `false`. The default TTY renderer may promote `color` and
 * `notifications` exactly once after an async substrate probe; `interactive`
 * and `animation` never demote. See §8.9 for the exact run-shape table.
 */
export const RendererCapabilities = Schema.Struct({
  color: Schema.Boolean.annotations({ description: "ANSI color output supported." }),
  interactive: Schema.Boolean.annotations({
    description: "Keyboard input honored (task-tree focus/expand, prompts).",
  }),
  animation: Schema.Boolean.annotations({
    description: "Continuous/live redraw supported (spinners, progress fill).",
  }),
  notifications: Schema.Boolean.annotations({
    description: "Desktop-notification path supported (§8.9.7).",
  }),
});
export type RendererCapabilities = typeof RendererCapabilities.Type;

/** Permanent all-false snapshot for non-TTY, plain, json, and degraded runs. */
export const RENDERER_CAPABILITIES_NONE: RendererCapabilities = Object.freeze({
  color: false,
  interactive: false,
  animation: false,
  notifications: false,
});

/**
 * Initial default-renderer TTY snapshot installed synchronously so first paint
 * never blocks on the substrate capability probe.
 */
export const RENDERER_CAPABILITIES_TTY_INITIAL: RendererCapabilities = Object.freeze({
  color: false,
  interactive: true,
  animation: true,
  notifications: false,
});

/** Verbose-mode TTY snapshot: color only; never interactive/animated/notifying. */
export const RENDERER_CAPABILITIES_VERBOSE_TTY: RendererCapabilities = Object.freeze({
  color: true,
  interactive: false,
  animation: false,
  notifications: false,
});
