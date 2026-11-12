import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

export const PaintBannerEvent = Schema.TaggedStruct("paint.banner", {
  banner: Schema.String,
  timestamp: Timestamp,
});
export type PaintBannerEvent = typeof PaintBannerEvent.Type;

export {
  CommandInvocationCorrelation,
  type CommandInvocationCorrelation as CommandInvocationCorrelationType,
  NotifyDesktopEvent,
  type NotifyDesktopEvent as NotifyDesktopEventType,
} from "./notify.ts";

export {
  CodeSnippetEvent,
  type CodeSnippetEvent as CodeSnippetEventType,
  DiffRenderEvent,
  type DiffRenderEvent as DiffRenderEventType,
  MarkdownBlockEvent,
  type MarkdownBlockEvent as MarkdownBlockEventType,
  RenderEvent,
  type RenderEvent as RenderEventType,
} from "./rich-render.ts";
