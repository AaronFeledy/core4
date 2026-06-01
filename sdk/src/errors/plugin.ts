import { Schema } from "effect";

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
