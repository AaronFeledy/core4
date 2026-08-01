import { Schema } from "effect";

import type { LandoPluginModule } from "../plugins/module.ts";
import { PluginManifest } from "./plugin.ts";

export const EmbeddingPluginPolicyMode = Schema.Literal("none", "bundled-only", "explicit", "discovery");
export type EmbeddingPluginPolicyMode = typeof EmbeddingPluginPolicyMode.Type;

export const EmbeddingPluginDiscoveryPolicy = Schema.Struct({
  bundled: Schema.optional(Schema.Boolean),
  system: Schema.optional(Schema.Boolean),
  user: Schema.optional(Schema.Boolean),
  app: Schema.optional(Schema.Boolean),
});
export type EmbeddingPluginDiscoveryPolicy = typeof EmbeddingPluginDiscoveryPolicy.Type;

const LandoPluginModuleEntry = Schema.Unknown.pipe(
  Schema.filter(
    (input): input is LandoPluginModule =>
      typeof input === "object" &&
      input !== null &&
      "name" in input &&
      typeof input.name === "string" &&
      "manifest" in input &&
      Schema.is(PluginManifest)(input.manifest) &&
      (!("certificateAuthorities" in input) || input.certificateAuthorities instanceof Map),
    { message: () => "Expected an already-loaded LandoPluginModule object.", jsonSchema: {} },
  ),
);

export const ResolvedPluginInput = Schema.Struct({
  manifest: PluginManifest,
  entry: LandoPluginModuleEntry,
});
export type ResolvedPluginInput = typeof ResolvedPluginInput.Type;

export const EmbeddingPluginPolicy = Schema.Union(
  EmbeddingPluginPolicyMode,
  Schema.Struct({
    mode: Schema.optional(EmbeddingPluginPolicyMode),
    layers: Schema.optional(Schema.Array(Schema.Unknown)),
    manifests: Schema.optional(Schema.Array(ResolvedPluginInput)),
    discovery: Schema.optional(EmbeddingPluginDiscoveryPolicy),
    externalImports: Schema.optional(Schema.Boolean),
    disable: Schema.optional(Schema.Array(Schema.String)),
  }),
);
export type EmbeddingPluginPolicy = typeof EmbeddingPluginPolicy.Type;
