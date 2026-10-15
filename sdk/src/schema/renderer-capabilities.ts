import { Schema } from "effect";

// RendererCapabilities — public, renderer-neutral capability surface.

/**
 * Boolean capability snapshot every renderer publishes. Owned exclusively by the
 * resolved `Renderer`; no other service or command infers capabilities.
 *
 * Snapshots are immutable. Renderers that promote capabilities must do so
 * monotonically: a supported capability never demotes within a run. The default
 * renderer publishes its TTY or non-TTY snapshot synchronously at construction.
 */
export const RendererCapabilities = Schema.Struct({
  color: Schema.Boolean.annotate({ description: "ANSI color output supported." }),
  interactive: Schema.Boolean.annotate({
    description: "Keyboard input honored (task-tree focus/expand, prompts).",
  }),
  animation: Schema.Boolean.annotate({
    description: "Continuous/live redraw supported (spinners, progress fill).",
  }),
  notifications: Schema.Boolean.annotate({
    description: "Desktop-notification path supported.",
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

/** Default-renderer TTY snapshot, published synchronously at construction. */
export const RENDERER_CAPABILITIES_TTY: RendererCapabilities = Object.freeze({
  color: true,
  interactive: true,
  animation: true,
  notifications: true,
});

/** Verbose-mode TTY snapshot: color only; never interactive/animated/notifying. */
export const RENDERER_CAPABILITIES_VERBOSE_TTY: RendererCapabilities = Object.freeze({
  color: true,
  interactive: false,
  animation: false,
  notifications: false,
});
