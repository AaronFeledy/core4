import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Schema } from "effect";

import { AppId, ProviderId, ServiceName, ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";

import type { NormalizedRoute } from "@lando/landofile/route-normalize";

import { finalizeServices } from "../../src/planner/endpoints.ts";
import type { PlannedServiceDraft } from "../../src/planner/service-types.ts";

const APP_ROOT = "/tmp/myapp";
const APP_SLUG = "myapp";
const DEFAULT_DOMAIN = "lndo.site";
const PROVIDER = ProviderId.make("lando");
const HTTP_ENDPOINT = {
  _tag: "internal" as const,
  protocol: "http" as const,
  port: 80,
  name: "http",
};

const phpishDraft = (routes: ReadonlyArray<NormalizedRoute> | undefined): PlannedServiceDraft => ({
  name: "appserver",
  hostnames: [],
  authoredArtifact: undefined,
  authored: { byStore: new Map() },
  authoredStorage: undefined,
  homeIntent: { serviceType: "lando", home: false as const },
  draft: {
    name: ServiceName.make("appserver"),
    serviceName: "appserver",
    type: "php",
    serviceType: "php",
    provider: PROVIDER,
    primary: true,
    base: "lando",
    featureIds: [],
    normalizedConfig: {},
    environment: {},
    mounts: [],
    storage: [],
    buildSteps: [],
    endpoints: [HTTP_ENDPOINT],
    dependsOn: [],
    hostAliases: [],
  },
  logSources: [],
  routes,
  extensions: {},
});

const metadata: ServicePlan["metadata"] = {
  resolvedAt: DateTime.makeUnsafe("2026-08-25T00:00:00Z"),
  source: `${APP_ROOT}/.lando.yml`,
  runtime: 4,
};

describe("finalizeServices auto-generated hostnames", () => {
  test.each(["docker", "lando"])("keeps %s HTTP endpoints internal", async (providerId) => {
    const provider = ProviderId.make(providerId);
    const draft = phpishDraft(undefined);
    const result = await Effect.runPromise(
      finalizeServices({
        plannedServiceDrafts: [{ ...draft, draft: { ...draft.draft, provider } }],
        appId: AppId.make(APP_SLUG),
        appRoot: APP_ROOT,
        appSlug: APP_SLUG,
        appName: APP_SLUG,
        defaultDomain: DEFAULT_DOMAIN,
        provider,
        providerCapabilities: { ...TestRuntimeProvider.capabilities, sharedCrossAppNetwork: true },
        metadata,
        selectFileSyncEngine: Effect.succeed(undefined),
        ordinaryFileSyncReason: "native-provider",
      }),
    );
    const service = Schema.decodeUnknownSync(ServicePlan)(result.services.appserver);
    expect(service.endpoints).toEqual([HTTP_ENDPOINT]);
  });
  test("routes to the marked HTTP primary after TCP using the configured default domain", async () => {
    // Given
    const draft = phpishDraft(undefined);
    const plannedServiceDraft: PlannedServiceDraft = {
      ...draft,
      draft: {
        ...draft.draft,
        endpoints: [
          { _tag: "internal", protocol: "tcp", port: 1025, name: "smtp" },
          { _tag: "internal", protocol: "http", port: 8080, name: "secondary" },
          { _tag: "internal", protocol: "http", port: 8025, name: "ui", primary: true },
        ],
      },
    };

    // When
    const finalized = await Effect.runPromise(
      finalizeServices({
        plannedServiceDrafts: [plannedServiceDraft],
        appId: AppId.make(APP_SLUG),
        appRoot: APP_ROOT,
        appSlug: APP_SLUG,
        appName: APP_SLUG,
        defaultDomain: "lando.test",
        provider: PROVIDER,
        providerCapabilities: TestRuntimeProvider.capabilities,
        metadata,
        selectFileSyncEngine: Effect.succeed(undefined),
        ordinaryFileSyncReason: "native-provider",
      }),
    );

    // Then
    expect(finalized.routes).toHaveLength(1);
    expect(finalized.routes[0]).toMatchObject({
      hostname: `appserver.${APP_SLUG}.lando.test`,
      scheme: "https",
      endpoint: "ui",
      backend: { service: "appserver", protocol: "http", port: 8025 },
    });
  });

  test("still auto-generates service.slug.lndo.site without authored routes", async () => {
    // Given / When
    const finalized = await Effect.runPromise(
      finalizeServices({
        plannedServiceDrafts: [phpishDraft(undefined)],
        appId: AppId.make(APP_SLUG),
        appRoot: APP_ROOT,
        appSlug: APP_SLUG,
        appName: APP_SLUG,
        defaultDomain: DEFAULT_DOMAIN,
        provider: PROVIDER,
        providerCapabilities: TestRuntimeProvider.capabilities,
        metadata,
        selectFileSyncEngine: Effect.succeed(undefined),
        ordinaryFileSyncReason: "native-provider",
      }),
    );

    // Then
    expect(finalized.routes.map((route) => route.hostname)).toEqual([
      `appserver.${APP_SLUG}.${DEFAULT_DOMAIN}`,
    ]);
  });
});
