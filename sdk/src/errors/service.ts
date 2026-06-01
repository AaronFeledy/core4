import { Schema } from "effect";

export class ServiceTypeError extends Schema.TaggedError<ServiceTypeError>()("ServiceTypeError", {
  message: Schema.String,
  serviceType: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class ServiceFeatureError extends Schema.TaggedError<ServiceFeatureError>()("ServiceFeatureError", {
  message: Schema.String,
  feature: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}
