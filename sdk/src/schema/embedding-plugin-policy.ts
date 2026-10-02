import { Schema } from "effect";

import type { LandoPluginModule } from "../plugins/module.ts";
import { PluginManifest } from "./plugin.ts";

export const EmbeddingPluginPolicyMode = Schema.Literals(["none", "bundled-only", "explicit", "discovery"]);
export type EmbeddingPluginPolicyMode = typeof EmbeddingPluginPolicyMode.Type;

export const EmbeddingPluginDiscoveryPolicy = Schema.Struct({
  bundled: Schema.optionalKey(Schema.Boolean),
  system: Schema.optionalKey(Schema.Boolean),
  user: Schema.optionalKey(Schema.Boolean),
  app: Schema.optionalKey(Schema.Boolean),
});
export type EmbeddingPluginDiscoveryPolicy = typeof EmbeddingPluginDiscoveryPolicy.Type;

const LandoPluginModuleEntry = Schema.Unknown.pipe(
  Schema.refine(
      (input): input is LandoPluginModule =>
        typeof input === "object" &&
        input !== null &&
        "name" in input &&
        typeof input.name === "string" &&
        "manifest" in input &&
        Schema.is(PluginManifest)(input.manifest) &&
        (!("certificateAuthorities" in input) || input.certificateAuthorities instanceof Map),
      { message: "Expected an already-loaded LandoPluginModule object." },
  ),
);

export const ResolvedPluginInput = Schema.Struct({
  manifest: PluginManifest,
  entry: LandoPluginModuleEntry,
});
export type ResolvedPluginInput = typeof ResolvedPluginInput.Type;

export const EmbeddingPluginPolicy = Schema.Union([
  EmbeddingPluginPolicyMode,
  Schema.Struct({
    mode: Schema.optionalKey(EmbeddingPluginPolicyMode),
    layers: Schema.optionalKey(Schema.Array(Schema.Unknown)),
    manifests: Schema.optionalKey(Schema.Array(ResolvedPluginInput)),
    discovery: Schema.optionalKey(EmbeddingPluginDiscoveryPolicy),
    externalImports: Schema.optionalKey(Schema.Boolean),
    disable: Schema.optionalKey(Schema.Array(Schema.String)),
  }),
]);
export type EmbeddingPluginPolicy = typeof EmbeddingPluginPolicy.Type;
