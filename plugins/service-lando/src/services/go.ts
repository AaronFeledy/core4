import { Schema } from "effect";

import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { makeLanguageRuntime } from "./_language-runtime.ts";

export const SUPPORTED_GO_VERSIONS = ["1.22", "1.23"] as const;
export type SupportedGoVersion = (typeof SUPPORTED_GO_VERSIONS)[number];
const GO_ARTIFACTS = Object.fromEntries(
  SUPPORTED_GO_VERSIONS.map((version) => [version, `golang:${version}`]),
);

export const SUPPORTED_GO_FRAMEWORKS = ["none"] as const;
export type SupportedGoFramework = (typeof SUPPORTED_GO_FRAMEWORKS)[number];

export const GO_FEATURE_ID = "service-lando.go" as const;
export const GO_FEATURE_PRIORITY = 600;

const GoFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literals([...SUPPORTED_GO_FRAMEWORKS]),
  version: Schema.Literals([...SUPPORTED_GO_VERSIONS]),
  port: Schema.Number,
  defaultCommand: Schema.optionalKey(Schema.Union([Schema.Null, Schema.Array(Schema.String)])),
});
type GoFeatureConfig = typeof GoFeatureConfigSchema.Type;
const configFor = (ctx: ServiceFeatureContext): GoFeatureConfig => ctx.config as GoFeatureConfig;

const runtime = makeLanguageRuntime({
  language: "go",
  displayName: "Go",
  versions: SUPPORTED_GO_VERSIONS,
  artifacts: GO_ARTIFACTS,
  artifactFor: (version) => `golang:${version}`,
  frameworks: SUPPORTED_GO_FRAMEWORKS,
  presets: { none: { port: 8080, defaultCommand: null } },
  baseEnv: { GOPATH: "/go", GOCACHE: "/root/.cache/go-build", CGO_ENABLED: "0" },
  mountExcludes: [],
  mountRealization: "passthrough",
  includeWebrootInFeatureConfig: false,
  extensionKey: "lando-service-go",
  featureId: GO_FEATURE_ID,
  priority: GO_FEATURE_PRIORITY,
  featureSchema: GoFeatureConfigSchema,
  configFor,
  applyFallback: "service-lando.go failed to apply",
  resolveFallback: (version) => `Failed to resolve go:${version}`,
});

export const goServiceFeature: ServiceFeatureDefinition = runtime.serviceFeature;
const makeGoServiceType = runtime.makeServiceType;
export const go122ServiceType: ServiceType = makeGoServiceType("1.22");
export const go123ServiceType: ServiceType = makeGoServiceType("1.23");
