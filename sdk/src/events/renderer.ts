import { Schema } from "effect";

import { Timestamp } from "./_shared.ts";

export const PaintBannerEvent = Schema.TaggedStruct("paint.banner", {
  banner: Schema.String,
  timestamp: Timestamp,
});
export type PaintBannerEvent = typeof PaintBannerEvent.Type;
