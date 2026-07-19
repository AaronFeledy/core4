import { Schema } from "effect";

import { BootstrapLevel } from "../schema/primitives.ts";

export class PluginLoadError extends Schema.TaggedError<PluginLoadError>()("PluginLoadError", {
  message: Schema.String,
  pluginName: Schema.String,
  cause: Schema.optional(Schema.Unknown),
}) {}

export class PluginManifestError extends Schema.TaggedError<PluginManifestError>()("PluginManifestError", {
  message: Schema.String,
  pluginName: Schema.optional(Schema.String),
  issues: Schema.Array(Schema.String),
}) {}

export class SubscriberLevelMismatchError extends Schema.TaggedError<SubscriberLevelMismatchError>()(
  "SubscriberLevelMismatchError",
  {
    message: Schema.String,
    remediation: Schema.String,
    pluginName: Schema.String,
    subscriberId: Schema.String,
    selectedEvent: Schema.String,
    declaredLevel: BootstrapLevel,
    eventLevel: Schema.Literal("minimal", "plugins", "commands", "tooling", "provider", "app"),
  },
) {}
