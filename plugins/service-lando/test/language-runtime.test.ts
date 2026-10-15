import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";

import { PortablePath } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType, ServiceTypeResolution } from "@lando/sdk/services";

import { landoAppMountFeature } from "../src/features/app-mount.ts";
import { makeLanguageRuntime } from "../src/services/_language-runtime.ts";
import { go122ServiceType, goServiceFeature } from "../src/services/go.ts";
import { python312ServiceType, pythonServiceFeature } from "../src/services/python.ts";
import { ruby33ServiceType, rubyServiceFeature } from "../src/services/ruby.ts";
import { composeServicePlan } from "./support/compose-harness.ts";
import { recordFeatureContext } from "./support/record-feature-context.ts";

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
    includeWebroot: false,
    resolution: {
      base: "lando",
      normalizedConfig: { type: "go:1.22" },
      features: [
        {
          id: "service-lando.go",
          config: { framework: "none", version: "1.22", port: 8080, defaultCommand: null },
        },
        { id: "lando.env", config: {} },
        { id: "lando.app-mount", config: { target: "/app", excludes: [] } },
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
    includeWebroot: false,
    resolution: {
      base: "lando",
      normalizedConfig: { type: "python:3.12" },
      features: [
        {
          id: "service-lando.python",
          config: { framework: "none", version: "3.12", port: 8000, defaultCommand: null },
        },
        { id: "lando.env", config: {} },
        {
          id: "lando.app-mount",
          config: { target: "/app", excludes: ["__pycache__"] },
        },
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
    includeWebroot: true,
    resolution: {
      base: "lando",
      normalizedConfig: { type: "ruby:3.3" },
      features: [
        {
          id: "service-lando.ruby",
          config: { framework: "none", version: "3.3", port: 3000, webroot: "/app", defaultCommand: null },
        },
        { id: "lando.env", config: { webroot: "/app" } },
        { id: "lando.app-mount", config: { target: "/app", excludes: [".bundle"] } },
      ],
    },
    mounts: [
      [
        "setAppMount",
        { source: "/srv/apps/myapp", target: "/app", readOnly: false, excludes: [".bundle"], includes: [] },
      ],
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
  const mountConfig = resolution.features.find((ref) => ref.id === "lando.app-mount")?.config;
  if (mountConfig === undefined) throw new Error("Missing app-mount feature config");
  Effect.runSync(landoAppMountFeature.apply({ ...ctx, config: mountConfig }));
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
    test(`${fixture.language} ${source} resolution declares app-mount feature defaults`, () => {
      // Given
      const input = inputFor(serviceType);
      // When
      const resolution = Effect.runSync(serviceType.resolve(input));
      // Then
      expect(resolution).toEqual(fixture.resolution);
      expect(JSON.stringify(resolution)).toBe(JSON.stringify(fixture.resolution));
    });

    test(`${fixture.language} ${source} app-mount feature owns the mount intent`, () => {
      // Given
      const resolution = Effect.runSync(serviceType.resolve(inputFor(serviceType)));
      // When
      const mounts = mountIntents(feature, resolution);
      // Then
      expect(mounts).toEqual(fixture.mounts);
      expect(JSON.stringify(mounts)).toBe(JSON.stringify(fixture.mounts));
    });

    test(`${fixture.language} ${source} projects authored webroot only when enabled`, async () => {
      // Given: an authored webroot on each shared-runtime consumer.
      const input = inputFor(serviceType);
      const service = { ...input.service, webroot: PortablePath.make("frontend/public") };
      // When: the real service features compose the plan.
      const plan = await composeServicePlan({
        serviceType,
        service,
        appRoot: input.appRoot,
        metadata: input.metadata,
      });
      // Then: only webroot-enabled consumers project it into env and extension metadata.
      const expected = fixture.includeWebroot ? { webroot: "/app/frontend/public" } : {};
      expect<string | undefined>(plan.environment.LANDO_WEBROOT).toBe(expected.webroot);
      expect(plan.extensions[`lando-service-${fixture.language}`]).toEqual({
        ...fixture.resolution.features[0].config,
        ...expected,
      });
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
