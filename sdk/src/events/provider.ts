import { Schema } from "effect";

import { AppRef } from "../schema/networking.ts";
import { ServiceName } from "../schema/primitives.ts";
import { Timestamp } from "./_shared.ts";

export const PreProviderApplyEvent = Schema.TaggedStruct("pre-provider-apply", {
  app: AppRef,
  providerId: Schema.String,
  timestamp: Timestamp,
});
export type PreProviderApplyEvent = typeof PreProviderApplyEvent.Type;

export const PostProviderApplyEvent = Schema.TaggedStruct("post-provider-apply", {
  app: AppRef,
  providerId: Schema.String,
  timestamp: Timestamp,
});
export type PostProviderApplyEvent = typeof PostProviderApplyEvent.Type;

export const PreProviderExecEvent = Schema.TaggedStruct("pre-provider-exec", {
  app: AppRef,
  service: ServiceName,
  timestamp: Timestamp,
});
export type PreProviderExecEvent = typeof PreProviderExecEvent.Type;

export const PostProviderExecEvent = Schema.TaggedStruct("post-provider-exec", {
  app: AppRef,
  service: ServiceName,
  exitCode: Schema.Number,
  timestamp: Timestamp,
});
export type PostProviderExecEvent = typeof PostProviderExecEvent.Type;
