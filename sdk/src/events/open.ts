import { Schema } from "effect";

import { AppRef } from "../schema/networking.ts";
import { Timestamp } from "./_shared.ts";

/**
 * Lifecycle events published by `app:open` for every URL it opens. The `url`
 * field carries an already-redacted summary string, never a raw secret-bearing
 * query string.
 */

export const PreOpenUrlEvent = Schema.TaggedStruct("pre-open-url", {
  app: AppRef,
  /** Redacted URL summary being opened. */
  url: Schema.String,
  timestamp: Timestamp,
});
export type PreOpenUrlEvent = typeof PreOpenUrlEvent.Type;

export const PostOpenUrlEvent = Schema.TaggedStruct("post-open-url", {
  app: AppRef,
  /** Redacted URL summary that was opened. */
  url: Schema.String,
  timestamp: Timestamp,
});
export type PostOpenUrlEvent = typeof PostOpenUrlEvent.Type;
