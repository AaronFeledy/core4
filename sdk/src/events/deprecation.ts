import { Schema } from "effect";

import { DeprecationUse } from "../schema/deprecation.ts";

export const DeprecationUsedEvent = Schema.TaggedStruct("deprecation-used", {
  use: DeprecationUse,
}).annotations({
  identifier: "DeprecationUsedEvent",
  title: "Deprecation Used Event",
  description:
    "Emitted after a deprecated surface use is recorded; telemetry and embedding subscribers should consume it as a late observer.",
});
export type DeprecationUsedEvent = typeof DeprecationUsedEvent.Type;
