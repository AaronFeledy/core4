import { Schema } from "effect";

import { NotifyDesktopEvent } from "./notify.ts";

// ====
// Rich render events — contract-only freeze for 4.0 (§8.9.4).
// SPEC: spec/08-cli-and-tooling.md §8.9.4

/**
 * Structured code snippet. 4.0 renderers emit verbatim text (optionally fenced);
 * rich TTY presentation lands in 4.1.
 */
export const CodeSnippetEvent = Schema.TaggedStruct("code.snippet", {
  code: Schema.String.annotations({ description: "Source code text to render." }),
  language: Schema.optional(Schema.String).annotations({
    description: "Optional tree-sitter language id; plain text when absent or unknown.",
  }),
  path: Schema.optional(Schema.String).annotations({
    description: "Optional display-only origin path (already redacted by the publisher).",
  }),
  startLine: Schema.optional(Schema.Number.pipe(Schema.int(), Schema.positive())).annotations({
    description: "Optional 1-based first line number for gutter numbering.",
  }),
  highlightLines: Schema.optional(
    Schema.Array(Schema.Number.pipe(Schema.int(), Schema.positive())),
  ).annotations({
    description: "Optional 1-based line numbers to highlight.",
  }),
});
export type CodeSnippetEvent = typeof CodeSnippetEvent.Type;

/**
 * Unified-diff render request. 4.0 emitters/renderers keep patch(1)-applicable
 * plain text; colorized hunks land in 4.1.
 */
export const DiffRenderEvent = Schema.TaggedStruct("diff.render", {
  unified: Schema.String.annotations({ description: "Standard unified-diff text." }),
  path: Schema.optional(Schema.String).annotations({
    description: "Optional display-only path for the diff.",
  }),
  language: Schema.optional(Schema.String).annotations({
    description: "Optional language hint for syntax-aware presentation in 4.1.",
  }),
});
export type DiffRenderEvent = typeof DiffRenderEvent.Type;

/**
 * Markdown block. 4.0 renderers emit the source verbatim; terminal markdown is 4.1.
 */
export const MarkdownBlockEvent = Schema.TaggedStruct("markdown.block", {
  markdown: Schema.String.annotations({ description: "Markdown source to render or pass through." }),
});
export type MarkdownBlockEvent = typeof MarkdownBlockEvent.Type;

/**
 * Closed render-event vocabulary plugins may publish through
 * LandoPluginContext.events.publishRender. Includes rich content events and
 * notify.desktop.
 */
export const RenderEvent = Schema.Union(
  CodeSnippetEvent,
  DiffRenderEvent,
  MarkdownBlockEvent,
  NotifyDesktopEvent,
);
export type RenderEvent = typeof RenderEvent.Type;
