import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit, Option } from "effect";

import { ConfigExpressionError, LandofileValidationError } from "@lando/sdk/errors";
import { AppId, ProviderId, type RouteInput, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { finalizeServices, resolveRoute } from "../../src/planner/endpoints.ts";
import type { PlannedServiceDraft } from "../../src/planner/service-types.ts";

const APP_ROOT = "/tmp/myapp";
const APP_NAME = "myapp";
const APP_SLUG = "myapp";
const DEFAULT_DOMAIN = "lndo.site";
const PROVIDER = ProviderId.make("lando");
const HTTP_ENDPOINT = {
  _tag: "internal" as const,
  protocol: "http" as const,
  port: 80,
  name: "http",
};

const expressionInput = {
  routeIndex: 0,
  appName: APP_NAME,
  appSlug: APP_SLUG,
  defaultDomain: DEFAULT_DOMAIN,
};

const hostnameTemplate = "{{ app.name }}.{{ proxy.defaultDomain }}";

const requireConfigExpressionError = (failure: unknown): ConfigExpressionError => {
  if (!(failure instanceof ConfigExpressionError)) {
    throw new Error("expected ConfigExpressionError");
  }
  return failure;
};

const phpishDraft = (routes: ReadonlyArray<RouteInput>): PlannedServiceDraft => ({
  name: "appserver",
  hostnames: [],
  authoredArtifact: undefined,
  authored: { byStore: new Map() },
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
    buildSteps: [],
    storage: [],
    endpoints: [HTTP_ENDPOINT],
    dependsOn: [],
    hostAliases: [],
  },
  logSources: [],
  routes,
  extensions: {},
});

const metadata: ServicePlan["metadata"] = {
  resolvedAt: DateTime.unsafeMake("2026-08-25T00:00:00Z"),
  source: `${APP_ROOT}/.lando.yml`,
  runtime: 4,
};

describe("resolveRoute hostname expressions", () => {
  test("evaluates an authored php hostname template to app.lndo.site", async () => {
    // Given
    const route: RouteInput = { hostname: hostnameTemplate };

    // When
    const planned = await Effect.runPromise(
      resolveRoute(APP_ROOT, "appserver", [HTTP_ENDPOINT], route, expressionInput),
    );

    // Then
    expect(planned.hostname).toBe(`${APP_NAME}.${DEFAULT_DOMAIN}`);
  });

  test("maps an unknown scope to ConfigExpressionError with the YAML path", async () => {
    // Given
    const route: RouteInput = { hostname: "{{ env.HOME }}" };

    // When
    const exit = await Effect.runPromiseExit(
      resolveRoute(APP_ROOT, "appserver", [HTTP_ENDPOINT], route, expressionInput),
    );

    // Then
    if (Exit.isSuccess(exit)) throw new Error("expected ConfigExpressionError");
    const failure = requireConfigExpressionError(Option.getOrThrow(Cause.failureOption(exit.cause)));
    expect(failure).toMatchObject({
      _tag: "ConfigExpressionError",
      expression: "{{ env.HOME }}",
      path: "services.appserver.routes.0.hostname",
      filePath: `${APP_ROOT}/.lando.yml`,
    });
    expect(failure.remediation).toContain("proxy.defaultDomain");
  });

  test("surfaces expression failure before endpoint mismatch", async () => {
    // Given
    const route: RouteInput = { hostname: "{{ env.HOME }}", endpoint: 9999 };

    // When
    const exit = await Effect.runPromiseExit(
      resolveRoute(APP_ROOT, "appserver", [HTTP_ENDPOINT], route, expressionInput),
    );

    // Then
    if (Exit.isSuccess(exit)) throw new Error("expected ConfigExpressionError");
    const failure = requireConfigExpressionError(Option.getOrThrow(Cause.failureOption(exit.cause)));
    expect(failure).not.toBeInstanceOf(LandofileValidationError);
    expect(failure.path).toBe("services.appserver.routes.0.hostname");
  });
});

describe("finalizeServices auto-generated hostnames", () => {
  test("still auto-generates service.slug.lndo.site without authored routes", async () => {
    // Given / When
    const finalized = await Effect.runPromise(
      finalizeServices({
        plannedServiceDrafts: [phpishDraft([])],
        appId: AppId.make(APP_SLUG),
        appRoot: APP_ROOT,
        appSlug: APP_SLUG,
        appName: APP_NAME,
        defaultDomain: DEFAULT_DOMAIN,
        provider: PROVIDER,
        providerCapabilities: TestRuntimeProvider.capabilities,
        metadata,
        fileSyncEngineId: undefined,
      }),
    );

    // Then
    expect(finalized.routes.map((route) => route.hostname)).toEqual([
      `appserver.${APP_SLUG}.${DEFAULT_DOMAIN}`,
    ]);
  });
});
