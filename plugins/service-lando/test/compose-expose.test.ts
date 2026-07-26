import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { COMPOSE_FEATURE_ID, composeServiceFeature, composeServiceType } from "../src/services/compose.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const appRoot = mkdtempSync(join(tmpdir(), "lando-compose-expose-"));
afterAll(() => rmSync(appRoot, { recursive: true, force: true }));

const planService = async (serviceConfig: unknown) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "us469",
    services: { web: serviceConfig },
  });
  const service = landofile.services?.[ServiceName.make("web")];
  if (service === undefined) throw new Error("web service missing");
  return composeServicePlan({
    serviceType: composeServiceType,
    service,
    appRoot,
    appName: "us469",
    metadata: { resolvedAt: "2026-07-26T08:00:00Z", source: join(appRoot, ".lando.yml"), runtime: 4 },
    serviceName: "web",
    featureOverrides: new Map([[COMPOSE_FEATURE_ID, composeServiceFeature]]),
  });
};

test("creates only internal endpoints when expose is authored", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", expose: [3000, "4000-4001"] };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.endpoints).toEqual([
    { _tag: "internal", port: 3000, protocol: "tcp" },
    { _tag: "internal", port: 4000, protocol: "tcp" },
    { _tag: "internal", port: 4001, protocol: "tcp" },
  ]);
});

test("keeps range-expanded published port endpoints unnamed", async () => {
  // Given
  const service = { type: "compose", image: "alpine:3", ports: ["8080-8081"] };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.endpoints).toEqual([
    { _tag: "published", port: 8080, protocol: "tcp", publication: {} },
    { _tag: "published", port: 8081, protocol: "tcp", publication: {} },
  ]);
});

test("prefers explicit endpoints over both ports and expose", async () => {
  // Given
  const service = {
    type: "compose",
    image: "alpine:3",
    ports: ["8080:80"],
    expose: [3000],
    endpoints: [{ _tag: "internal", name: "web", protocol: "http", port: 80 }],
  };

  // When
  const plan = await planService(service);

  // Then
  expect(plan.endpoints).toEqual([{ _tag: "internal", name: "web", protocol: "http", port: 80 }]);
});
