import { Schema } from "effect";

import { AppRef } from "../schema/networking.ts";
import { ProviderId, ServiceName } from "../schema/primitives.ts";
import { Timestamp } from "./_shared.ts";

export const PreAppStartEvent = Schema.TaggedStruct("pre-app-start", {
  eventName: Schema.Literal("pre-app-start"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreAppStartEvent = typeof PreAppStartEvent.Type;

export const PostAppStartEvent = Schema.TaggedStruct("post-app-start", {
  eventName: Schema.Literal("post-app-start"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostAppStartEvent = typeof PostAppStartEvent.Type;

export const PreAppStopEvent = Schema.TaggedStruct("pre-app-stop", {
  eventName: Schema.Literal("pre-app-stop"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreAppStopEvent = typeof PreAppStopEvent.Type;

export const PostAppStopEvent = Schema.TaggedStruct("post-app-stop", {
  eventName: Schema.Literal("post-app-stop"),
  appRef: AppRef,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostAppStopEvent = typeof PostAppStopEvent.Type;

export const PreServiceStartEvent = Schema.TaggedStruct("pre-service-start", {
  eventName: Schema.Literal("pre-service-start"),
  appRef: AppRef,
  serviceName: ServiceName,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreServiceStartEvent = typeof PreServiceStartEvent.Type;

export const PostServiceStartEvent = Schema.TaggedStruct("post-service-start", {
  eventName: Schema.Literal("post-service-start"),
  appRef: AppRef,
  serviceName: ServiceName,
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostServiceStartEvent = typeof PostServiceStartEvent.Type;

export const PreServiceStopEvent = Schema.TaggedStruct("pre-service-stop", {
  eventName: Schema.Literal("pre-service-stop"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreServiceStopEvent = typeof PreServiceStopEvent.Type;

export const PostServiceStopEvent = Schema.TaggedStruct("post-service-stop", {
  eventName: Schema.Literal("post-service-stop"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostServiceStopEvent = typeof PostServiceStopEvent.Type;

export const PreBuildEvent = Schema.TaggedStruct("pre-build", {
  eventName: Schema.Literal("pre-build"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PreBuildEvent = typeof PreBuildEvent.Type;

export const PostBuildEvent = Schema.TaggedStruct("post-build", {
  eventName: Schema.Literal("post-build"),
  appRef: AppRef,
  serviceName: Schema.optional(ServiceName),
  providerId: ProviderId,
  timestamp: Timestamp,
});
export type PostBuildEvent = typeof PostBuildEvent.Type;
