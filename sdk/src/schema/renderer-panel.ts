import { Effect } from "effect";
import { Schema } from "effect";

import { LandoEvent } from "../events/union.ts";
import { AppRef } from "./networking.ts";

const RENDERER_PANEL_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

// ====
// Renderer panel slots, views, and manifest contribution shapes.

/**
 * Closed slot vocabulary for default-renderer panel contributions.
 * Renderers that do not implement slots ignore contributions; json/plain/non-TTY never render panels.
 */
export const RendererPanelSlot = Schema.Literals(["status-bar", "task-tree:footer", "doctor:summary"]);
export type RendererPanelSlot = typeof RendererPanelSlot.Type;

/**
 * Plugin-scoped panel id: lowercase, starts with a letter, hyphen-separated segments,
 * 1..64 characters total. Uniqueness is enforced per-plugin at manifest validation.
 */
export const RendererPanelId = Schema.String.pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(64)),
  Schema.check(
    Schema.isPattern(RENDERER_PANEL_ID_PATTERN, {
      toJsonSchema: () => ({ pattern: RENDERER_PANEL_ID_PATTERN.source }),
    }),
  ),
  Schema.brand("RendererPanelId"),
);
export type RendererPanelId = typeof RendererPanelId.Type;

/**
 * Event tags a panel re-renders on: 1..32 entries, unique. Shape-only at schema decode;
 * known-event membership is validated by the plugin loader after command registration.
 */
export const RendererPanelWatch = Schema.Array(Schema.String).pipe(
  Schema.check(Schema.isMinLength(1)),
  Schema.check(Schema.isMaxLength(32)),
  Schema.check(
    Schema.makeFilter((tags) => new Set(tags).size === tags.length, {
      message: "RendererPanelWatch entries must be unique",
    }),
  ),
);
export type RendererPanelWatch = typeof RendererPanelWatch.Type;

/**
 * Manifest contribution for a renderer panel. The host validates shape/id/slot/path
 * without importing the module; `watch` membership is checked after registration.
 */
export const RendererPanelManifestEntry = Schema.Struct({
  id: RendererPanelId.annotate({
    description: "Plugin-local panel id; must match the module's exported RendererPanel.id.",
  }),
  slot: RendererPanelSlot.annotate({
    description: "Target default-renderer slot (status-bar, task-tree:footer, or doctor:summary).",
  }),
  watch: RendererPanelWatch.annotate({
    description:
      "1..32 unique LandoEvent tags that trigger re-render (membership checked after registration).",
  }),
  module: Schema.String.annotate({
    description: "Relative module path under the plugin package root exporting a RendererPanel default.",
  }),
});
export type RendererPanelManifestEntry = typeof RendererPanelManifestEntry.Type;

/** Closed styling tone vocabulary for panel content. */
export const StyledSpanTone = Schema.Literals(["default", "muted", "accent", "success", "warning", "danger"]);
export type StyledSpanTone = typeof StyledSpanTone.Type;

/** One styled text span inside a panel row. */
export const StyledSpan = Schema.Struct({
  text: Schema.String.annotate({ description: "Span text content (UTF-8)." }),
  tone: StyledSpanTone.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => "default" as const))).annotate({
    description: "Semantic color tone (default muted accent success warning danger).",
  }),
  bold: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "Bold weight when true.",
  }),
  dim: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "Dim intensity when true.",
  }),
  italic: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "Italic style when true.",
  }),
  underline: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.sync(() => false))).annotate({
    description: "Underline decoration when true.",
  }),
});
export type StyledSpan = typeof StyledSpan.Type;

const encodedByteLength = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Bounded rows-of-spans: ≤8 rows, ≤32 spans/row, ≤4096 UTF-8 text bytes total.
 * Over-bound results fail decode (dropped); never clipped or truncated.
 */
export const PanelView = Schema.Array(
  Schema.Array(StyledSpan).pipe(Schema.check(Schema.isMaxLength(32))),
).pipe(
  Schema.check(Schema.isMaxLength(8)),
  Schema.check(
    Schema.makeFilter(
      (rows) =>
        rows.reduce((n, row) => n + row.reduce((m, span) => m + encodedByteLength(span.text), 0), 0) <= 4096,
      { message: "PanelView encoded text exceeds the 4096 UTF-8 byte total limit" },
    ),
  ),
);
export type PanelView = typeof PanelView.Type;

/** Positive terminal-size context for a panel slot. */
export const RendererPanelSize = Schema.Struct({
  columns: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))).annotate({
    description: "Positive terminal column count for the slot.",
  }),
  rows: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThan(0))).annotate({
    description: "Positive terminal row count for the slot.",
  }),
});
export type RendererPanelSize = typeof RendererPanelSize.Type;

/**
 * Context handed to a panel `render` call. `event` is any published LandoEvent;
 * panels re-render when a watched tag arrives.
 */
export const RendererPanelContext = Schema.Struct({
  app: Schema.optionalKey(AppRef).annotate({
    description: "Resolved app identity when a user app is in scope.",
  }),
  size: RendererPanelSize.annotate({
    description: "Positive terminal size of the target slot.",
  }),
  event: LandoEvent.annotate({
    description: "The LandoEvent that triggered this render (any published event).",
  }),
});
export type RendererPanelContext = typeof RendererPanelContext.Type;

/**
 * Pure panel module contract. Default export of a `rendererPanels:` module.
 * Schemas and the isolated-worker contract suite ship now; default-renderer slot wiring is deferred.
 */
export interface RendererPanel {
  readonly id: RendererPanelId;
  readonly render: (ctx: RendererPanelContext) => PanelView;
}
