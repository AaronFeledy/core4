import { Effect, Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import type { ServiceFeatureDefinition, ServiceType } from "@lando/sdk/services";

import { composeServicePlan } from "./compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-15T08:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const decodeWebService = () => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { web: { type: "stub" } },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return service;
};

const landoEnvStubServiceType: ServiceType = {
  id: "stub",
  name: "Stub",
  base: "lando",
  schema: LandofileShape,
  resolve: (input) =>
    Effect.succeed({
      base: "lando" as const,
      normalizedConfig: input.service,
      features: [{ id: "lando.env" }],
    }),
};

const extensionFeature: ServiceFeatureDefinition = {
  id: "test.extension",
  priority: 100,
  apply: (ctx) =>
    Effect.sync(() => {
      ctx.addExtension("x", { a: 1 });
    }),
};

const extensionStubServiceType: ServiceType = {
  id: "stub-extension",
  name: "Stub Extension",
  base: "lando",
  schema: LandofileShape,
  resolve: (input) =>
    Effect.succeed({
      base: "lando" as const,
      normalizedConfig: input.service,
      features: [{ id: "test.extension" }],
    }),
};

describe("composeServicePlan test harness", () => {
  test("wires base defaults and explicit lando.env feature through composition", async () => {
    const plan = await composeServicePlan({
      serviceType: landoEnvStubServiceType,
      service: decodeWebService(),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
    });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("web");
  });

  test("uses featureOverrides before the plugin feature map", async () => {
    const plan = await composeServicePlan({
      serviceType: extensionStubServiceType,
      service: decodeWebService(),
      appRoot: "/srv/apps/myapp",
      appName: "myapp",
      metadata,
      featureOverrides: new Map([[extensionFeature.id, extensionFeature]]),
    });

    expect(plan.extensions.x).toEqual({ a: 1 });
  });
});
