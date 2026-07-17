import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

export const PaintBannerEvent = Schema.TaggedStruct("paint.banner", {
  banner: Schema.String,
  timestamp: Timestamp,
});
export type PaintBannerEvent = typeof PaintBannerEvent.Type;

export {
  CommandInvocationCorrelation,
  NotifyDesktopEvent,
  type CommandInvocationCorrelation as CommandInvocationCorrelationType,
  type NotifyDesktopEvent as NotifyDesktopEventType,
} from "./notify.ts";
