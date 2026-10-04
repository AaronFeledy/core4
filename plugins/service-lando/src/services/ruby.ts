import { Schema } from "effect";

import type { ServiceFeatureContext, ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { type LanguageFrameworkPreset, makeLanguageRuntime } from "./_language-runtime.ts";

export const SUPPORTED_RUBY_VERSIONS = ["3.3"] as const;
export type SupportedRubyVersion = (typeof SUPPORTED_RUBY_VERSIONS)[number];
const RUBY_ARTIFACTS = Object.fromEntries(
  SUPPORTED_RUBY_VERSIONS.map((version) => [version, `ruby:${version}-slim`]),
);

export const SUPPORTED_RUBY_FRAMEWORKS = ["rails", "none"] as const;
export type SupportedRubyFramework = (typeof SUPPORTED_RUBY_FRAMEWORKS)[number];

export const RUBY_FEATURE_ID = "service-lando.ruby" as const;
export const RUBY_FEATURE_PRIORITY = 600;

const FRAMEWORK_PRESETS: Record<SupportedRubyFramework, LanguageFrameworkPreset> = {
  rails: {
    port: 3000,
    defaultCommand: ["bundle", "exec", "rails", "server", "-b", "0.0.0.0", "-p", "3000"],
    webroot: "/app/public",
    env: new Map([
      ["RAILS_ENV", "development"],
      ["RAILS_LOG_TO_STDOUT", "true"],
    ]),
  },
  none: {
    port: 3000,
    defaultCommand: null,
    webroot: "/app",
    env: new Map(),
  },
};

const RubyFeatureConfigSchema = Schema.Struct({
  framework: Schema.Literals([...SUPPORTED_RUBY_FRAMEWORKS]),
  version: Schema.Literals([...SUPPORTED_RUBY_VERSIONS]),
  port: Schema.Number,
  webroot: Schema.String,
  defaultCommand: Schema.optionalKey(Schema.Union([Schema.Null, Schema.Array(Schema.String)])),
});
type RubyFeatureConfig = typeof RubyFeatureConfigSchema.Type;
const configFor = (ctx: ServiceFeatureContext): RubyFeatureConfig => ctx.config as RubyFeatureConfig;

const runtime = makeLanguageRuntime({
  language: "ruby",
  displayName: "Ruby",
  versions: SUPPORTED_RUBY_VERSIONS,
  artifacts: RUBY_ARTIFACTS,
  artifactFor: (version) => `ruby:${version}-slim`,
  frameworks: SUPPORTED_RUBY_FRAMEWORKS,
  presets: FRAMEWORK_PRESETS,
  baseEnv: { BUNDLE_PATH: "vendor/bundle" },
  mountExcludes: [".bundle"],
  includeWebrootInFeatureConfig: true,
  extensionKey: "lando-service-ruby",
  featureId: RUBY_FEATURE_ID,
  priority: RUBY_FEATURE_PRIORITY,
  featureSchema: RubyFeatureConfigSchema,
  configFor,
  applyFallback: "service-lando.ruby failed to apply",
  resolveFallback: (version) => `Failed to resolve ruby:${version}`,
});

export const rubyServiceFeature: ServiceFeatureDefinition = runtime.serviceFeature;
export const makeRubyServiceType = runtime.makeServiceType;
export const ruby33ServiceType: ServiceType = makeRubyServiceType("3.3");
