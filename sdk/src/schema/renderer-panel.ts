import { Schema } from "effect";

import { LandoEvent } from "../events/union.ts";
import { AppRef } from "./networking.ts";

// ====
// Renderer panel slots — contract-only freeze for 4.0 (§8.9.5).
// SPEC: spec/08-cli-and-tooling.md §8.9.5

/**
 * Closed 4.0 slot vocabulary for default-renderer panel contributions.
 * Renderers that do not implement slots ignore contributions; json/plain/non-TTY never render panels.
 */
export const RendererPanelSlot = Schema.Literal("status-bar", "task-tree:footer", "doctor:summary");
export type RendererPanelSlot = typeof RendererPanelSlot.Type;

/**
 * Plugin-scoped panel id: lowercase, starts with a letter, hyphen-separated segments,
 * 1..64 characters total. Uniqueness is enforced per-plugin at manifest validation.
 */
export const RendererPanelId = Schema.String.pipe(
  Schema.minLength(1),
  Schema.maxLength(64),
  Schema.pattern(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
  Schema.brand("RendererPanelId"),
);
export type RendererPanelId = typeof RendererPanelId.Type;

/**
 * Event tags a panel re-renders on: 1..32 entries, unique. Shape-only at schema decode;
 * known-event membership is validated by the plugin loader after command registration.
 */
export const RendererPanelWatch = Schema.Array(Schema.String).pipe(
  Schema.minItems(1),
  Schema.maxItems(32),
  Schema.filter((tags) => new Set(tags).size === tags.length, {
    message: () => "RendererPanelWatch entries must be unique",
  }),
);
export type RendererPanelWatch = typeof RendererPanelWatch.Type;

/**
 * Manifest contribution for a renderer panel. The host validates shape/id/slot/path
 * without importing the module; `watch` membership is checked after registration.
 */
export const RendererPanelManifestEntry = Schema.Struct({
  id: RendererPanelId.annotations({
    description: "Plugin-local panel id; must match the module's exported RendererPanel.id.",
  }),
  slot: RendererPanelSlot.annotations({
    description: "Target default-renderer slot (status-bar, task-tree:footer, or doctor:summary).",
  }),
  watch: RendererPanelWatch.annotations({
    description:
      "1..32 unique LandoEvent tags that trigger re-render (membership checked after registration).",
  }),
  module: Schema.String.annotations({
    description: "Relative module path under the plugin package root exporting a RendererPanel default.",
  }),
});
export type RendererPanelManifestEntry = typeof RendererPanelManifestEntry.Type;

/** Closed styling tone vocabulary for panel content. */
export const StyledSpanTone = Schema.Literal("default", "muted", "accent", "success", "warning", "danger");
export type StyledSpanTone = typeof StyledSpanTone.Type;

/** One styled text span inside a panel row. */
export const StyledSpan = Schema.Struct({
  text: Schema.String.annotations({ description: "Span text content (UTF-8)." }),
  tone: Schema.optionalWith(StyledSpanTone, { default: () => "default" as const }).annotations({
    description: "Semantic color tone (default muted accent success warning danger).",
  }),
  bold: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    description: "Bold weight when true.",
  }),
  dim: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    description: "Dim intensity when true.",
  }),
  italic: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    description: "Italic style when true.",
  }),
  underline: Schema.optionalWith(Schema.Boolean, { default: () => false }).annotations({
    description: "Underline decoration when true.",
  }),
});
export type StyledSpan = typeof StyledSpan.Type;

/** UTF-8 byte length of a string (runtime-neutral; Bun/Node `TextEncoder`). */
export const encodedByteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Bounded rows-of-spans: ≤8 rows, ≤32 spans/row, ≤4096 UTF-8 text bytes total.
 * Over-bound results fail decode (dropped); never clipped or truncated.
 */
export const PanelView = Schema.Array(Schema.Array(StyledSpan).pipe(Schema.maxItems(32))).pipe(
  Schema.maxItems(8),
  Schema.filter(
    (rows) =>
      rows.reduce((n, row) => n + row.reduce((m, span) => m + encodedByteLength(span.text), 0), 0) <= 4096,
    { message: () => "PanelView encoded text exceeds the 4096 UTF-8 byte total limit" },
  ),
);
export type PanelView = typeof PanelView.Type;

/** Positive terminal-size context for a panel slot. */
export const RendererPanelSize = Schema.Struct({
  columns: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
    description: "Positive terminal column count for the slot.",
  }),
  rows: Schema.Number.pipe(Schema.int(), Schema.positive()).annotations({
    description: "Positive terminal row count for the slot.",
  }),
});
export type RendererPanelSize = typeof RendererPanelSize.Type;

/**
 * Context handed to a panel `render` call. `event` is any published LandoEvent;
 * panels re-render when a watched tag arrives.
 */
export const RendererPanelContext = Schema.Struct({
  app: Schema.optional(AppRef).annotations({
    description: "Resolved app identity when a user app is in scope.",
  }),
  size: RendererPanelSize.annotations({
    description: "Positive terminal size of the target slot.",
  }),
  event: LandoEvent.annotations({
    description: "The LandoEvent that triggered this render (any published event).",
  }),
});
export type RendererPanelContext = typeof RendererPanelContext.Type;

/**
 * Pure panel module contract. Default export of a `rendererPanels:` module.
 * 4.0 ships schemas + contract suite only; default-renderer slot wiring is 4.1.
 */
export interface RendererPanel {
  readonly id: RendererPanelId;
  readonly render: (ctx: RendererPanelContext) => PanelView;
}
