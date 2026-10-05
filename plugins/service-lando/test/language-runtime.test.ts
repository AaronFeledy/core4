import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import type { ServiceFeatureDefinition, ServiceType, ServiceTypeResolution } from "@lando/sdk/services";

import { makeLanguageRuntime } from "../src/services/_language-runtime.ts";
import { go122ServiceType, goServiceFeature } from "../src/services/go.ts";
import { python312ServiceType, pythonServiceFeature } from "../src/services/python.ts";
import { ruby33ServiceType, rubyServiceFeature } from "../src/services/ruby.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

// Captured by executing unchanged efb9e76a5 modules before the first source edit.
// Resolve returns feature references; raw mount intents are captured separately
// because composition would erase the omitted-vs-explicit realization difference.
const fixtures = [
  {
    language: "go",
    displayName: "Go",
    version: "1.22",
    artifact: "golang:1.22",
    serviceType: go122ServiceType,
    serviceFeature: goServiceFeature,
    baseEnv: { GOPATH: "/go", GOCACHE: "/root/.cache/go-build", CGO_ENABLED: "0" },
    excludes: [],
    mountRealization: "passthrough",
    includeWebroot: false,
    resolution: {
      base: "lando",
      normalizedConfig: { type: "go:1.22" },
      features: [
        {
          id: "service-lando.go",
          config: { framework: "none", version: "1.22", port: 8080, defaultCommand: null },
        },
        { id: "lando.env", config: { appPaths: { appRoot: "/app", projectMount: "/app" } } },
      ],
    },
    mounts: [
      [
        "setAppMount",
        {
          source: "/srv/apps/myapp",
          target: "/app",
          readOnly: false,
          excludes: [],
          includes: [],
          realization: "passthrough",
        },
      ],
      [
        "addMount",
        {
          type: "bind",
          source: "/srv/apps/myapp",
          target: "/app",
          readOnly: false,
          realization: "passthrough",
        },
      ],
    ],
  },
  {
    language: "python",
    displayName: "Python",
    version: "3.12",
    artifact: "python:3.12-slim",
    serviceType: python312ServiceType,
    serviceFeature: pythonServiceFeature,
    baseEnv: { PYTHONUNBUFFERED: "1", PYTHONDONTWRITEBYTECODE: "1" },
    excludes: ["__pycache__"],
    mountRealization: "passthrough",
    includeWebroot: false,
    resolution: {
      base: "lando",
      normalizedConfig: { type: "python:3.12" },
      features: [
        {
          id: "service-lando.python",
          config: { framework: "none", version: "3.12", port: 8000, defaultCommand: null },
        },
        { id: "lando.env", config: { appPaths: { appRoot: "/app", projectMount: "/app" } } },
      ],
    },
    mounts: [
      [
        "setAppMount",
        {
          source: "/srv/apps/myapp",
          target: "/app",
          readOnly: false,
          excludes: ["__pycache__"],
          includes: [],
          realization: "passthrough",
        },
      ],
      [
        "addMount",
        {
          type: "bind",
          source: "/srv/apps/myapp",
          target: "/app",
          readOnly: false,
          realization: "passthrough",
        },
      ],
    ],
  },
  {
    language: "ruby",
    displayName: "Ruby",
    version: "3.3",
    artifact: "ruby:3.3-slim",
    serviceType: ruby33ServiceType,
    serviceFeature: rubyServiceFeature,
    baseEnv: { BUNDLE_PATH: "vendor/bundle" },
    excludes: [".bundle"],
    mountRealization: undefined,
    includeWebroot: true,
    resolution: {
      base: "lando",
      normalizedConfig: { type: "ruby:3.3" },
      features: [
        {
          id: "service-lando.ruby",
          config: { framework: "none", version: "3.3", port: 3000, webroot: "/app", defaultCommand: null },
        },
        { id: "lando.env", config: { appPaths: { appRoot: "/app", projectMount: "/app" }, webroot: "/app" } },
      ],
    },
    mounts: [
      [
        "setAppMount",
        { source: "/srv/apps/myapp", target: "/app", readOnly: false, excludes: [".bundle"], includes: [] },
      ],
      ["addMount", { type: "bind", source: "/srv/apps/myapp", target: "/app", readOnly: false }],
    ],
  },
] as const;

const FeatureConfig = Schema.Struct({
  framework: Schema.Literal("none"),
  version: Schema.String,
  port: Schema.Number,
  defaultCommand: Schema.optionalKey(Schema.Union([Schema.Null, Schema.Array(Schema.String)])),
  webroot: Schema.optionalKey(Schema.String),
});

const inputFor = (serviceType: ServiceType) => ({
  name: "web",
  service: { type: serviceType.id },
  appRoot: "/srv/apps/myapp",
  metadata: { resolvedAt: "2026-05-18T08:00:00Z", source: "/srv/apps/myapp/.lando.yml", runtime: 4 as const },
});

const mountIntents = (
  feature: ServiceFeatureDefinition,
  resolution: ServiceTypeResolution,
): readonly (readonly unknown[])[] => {
  const { ctx, calls } = recordFeatureContext({
    serviceType: resolution.normalizedConfig.type ?? "",
    normalizedConfig: resolution.normalizedConfig,
    config: resolution.features[0]?.config ?? {},
  });
  Effect.runSync(feature.apply(ctx));
  return calls.filter(([method]) => method === "setAppMount" || method === "addMount");
};

for (const fixture of fixtures) {
  const factory = makeLanguageRuntime({
    language: fixture.language,
    displayName: fixture.displayName,
    versions: [fixture.version],
    artifacts: { [fixture.version]: fixture.artifact },
    artifactFor: () => fixture.artifact,
    frameworks: ["none"],
    presets: {
      none: {
        port: fixture.resolution.features[0].config.port,
        defaultCommand: null,
        webroot: "/app",
        env: new Map(),
      },
    },
    baseEnv: fixture.baseEnv,
    mountExcludes: fixture.excludes,
    ...(fixture.mountRealization === undefined ? {} : { mountRealization: fixture.mountRealization }),
    includeWebrootInFeatureConfig: fixture.includeWebroot,
    extensionKey: `lando-service-${fixture.language}`,
    featureId: `service-lando.${fixture.language}`,
    priority: 600,
    featureSchema: FeatureConfig,
    configFor: (ctx) => Schema.decodeUnknownSync(FeatureConfig)(ctx.config),
    applyFallback: `service-lando.${fixture.language} failed to apply`,
    resolveFallback: (version) => `Failed to resolve ${fixture.language}:${version}`,
  });

  for (const [source, serviceType, feature] of [
    ["module", fixture.serviceType, fixture.serviceFeature],
    ["factory", factory.makeServiceType(fixture.version), factory.serviceFeature],
  ] as const) {
    test(`${fixture.language} ${source} resolution equals the pre-refactor fixture`, () => {
      // Given
      const input = inputFor(serviceType);
      // When
      const resolution = Effect.runSync(serviceType.resolve(input));
      // Then
      expect(resolution).toEqual(fixture.resolution);
      expect(JSON.stringify(resolution)).toBe(JSON.stringify(fixture.resolution));
    });

    test(`${fixture.language} ${source} mount intents equal the pre-refactor fixture`, () => {
      // Given
      const resolution = Effect.runSync(serviceType.resolve(inputFor(serviceType)));
      // When
      const mounts = mountIntents(feature, resolution);
      // Then
      expect(mounts).toEqual(fixture.mounts);
      expect(JSON.stringify(mounts)).toBe(JSON.stringify(fixture.mounts));
    });
  }

  test(`${fixture.language} factory preserves version fallback and error remediation`, () => {
    // Given
    const version = fixture.version;
    // When / Then
    expect(factory.validateVersion(undefined, version)).toBe(version);
    expect(factory.validateVersion("other:1", version)).toBe(version);
    expect(() => factory.validateVersion(`${fixture.language}:bad`, version)).toThrow(
      `Unsupported ${fixture.displayName} version "bad". Set type to one of: ${fixture.language}:${version} (got ${fixture.language}:bad).`,
    );
    expect(factory.validateFramework(undefined)).toBe("none");
    expect(() => factory.validateFramework("bad")).toThrow(
      `Unsupported ${fixture.displayName} framework "bad". Set framework to one of: none (got bad).`,
    );
  });
}
