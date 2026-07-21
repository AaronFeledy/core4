import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DateTime, Effect, Layer, Stream } from "effect";

import { infoApp, renderInfoAppResult } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/core/schema";
import { AppPlanResolver, LandofileService, RuntimeProviderRegistry } from "@lando/core/services";
import type { RuntimeProviderShape } from "@lando/sdk/services";

/**
 * Regression guard: secret values MUST NOT appear in `lando info`
 * output (text or JSON). `infoApp` serializes only provider-neutral runtime
 * facts (service/status/endpoints) — never service `environment` or any resolved
 * `${secret:…}` value. This test locks that invariant so a future info JSON
 * renderer (or a serializer that starts including `environment`) cannot silently
 * leak a secret.
 */

const SECRET_VALUE = "supersecret-canary-value";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "info-no-secret.test",
  runtime: 4 as const,
};

const postgres: ServicePlan = {
  name: ServiceName.make("postgres"),
  type: "postgres",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "postgres:16-alpine" },
  command: ["postgres"],
  // The service carries a secret-shaped value in its environment; info must
  // never serialize this.
  environment: { POSTGRES_USER: "lando", POSTGRES_DB: "appdb", POSTGRES_PASSWORD: SECRET_VALUE },
  mounts: [],
  storage: [],
  endpoints: [{ port: 5432, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: AppId.make("test-info-secret"),
  name: "test-info-secret",
  slug: "test-info-secret",
  root: AbsolutePath.make("/tmp/test-info-secret"),
  provider: providerId,
  services: { [postgres.name]: postgres },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const makeInfoLayer = () => {
  const provider: RuntimeProviderShape = {
    id: "lando",
    displayName: "Lando Runtime Provider",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({ providerId: "lando", operation: "buildArtifact", message: "x" }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({ providerId: "lando", operation: "pullArtifact", message: "x" }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    execStream: () => Stream.die("not used"),
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.die("not used"),
    inspect: (target) =>
      Effect.succeed({
        app: plan.id,
        service: target.service,
        providerId,
        status: "running",
        state: "running",
        endpoints: plan.services[target.service]?.endpoints ?? [],
      }),
    list: () => Effect.succeed([]),
  };

  return Layer.mergeAll(
    Layer.succeed(LandofileService, {
      discover: Effect.succeed({ name: "test-info-secret", services: {} }),
    }),
    Layer.succeed(AppPlanResolver, { plan: () => Effect.succeed(plan) }),
    Layer.succeed(RuntimeProviderRegistry, {
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(provider),
    }),
  );
};

describe("lando info never leaks secret values", () => {
  let previous: string | undefined;

  beforeEach(() => {
    previous = process.env.LANDO_SECRET_DB_PASSWORD;
    process.env.LANDO_SECRET_DB_PASSWORD = SECRET_VALUE;
  });

  afterEach(() => {
    if (previous === undefined) {
      // biome-ignore lint/performance/noDelete: env cleanup must remove the key (Bun coerces undefined to the string "undefined" otherwise)
      delete process.env.LANDO_SECRET_DB_PASSWORD;
    } else {
      process.env.LANDO_SECRET_DB_PASSWORD = previous;
    }
  });

  test("neither the rendered text nor the JSON serialization contains a secret value", async () => {
    const result = await Effect.runPromise(infoApp().pipe(Effect.provide(makeInfoLayer())));

    const text = renderInfoAppResult(result);
    const json = JSON.stringify(result);

    expect(text).not.toContain(SECRET_VALUE);
    expect(json).not.toContain(SECRET_VALUE);
    expect(json).toContain("postgres");
  });
});
