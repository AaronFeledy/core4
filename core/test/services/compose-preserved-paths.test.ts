import { describe, expect, test } from "bun:test";
import { DateTime } from "effect";

import {
  type ComposePreservedPathCapabilities,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import {
  collectComposePreservedPaths,
  findUnsupportedComposePreservedPath,
} from "../../src/services/compose-preserved-paths.ts";

type ComposeCapabilityView = Pick<ProviderCapabilities, "composePreservedPaths" | "composeSpec">;

const servicePlan = (name: string, compose?: Record<string, unknown>): ServicePlan => ({
  name: ServiceName.make(name),
  type: "compose",
  provider: ProviderId.make("test"),
  primary: name === "web",
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata: {
    resolvedAt: DateTime.unsafeMake("2026-07-28T00:00:00.000Z"),
    source: "compose-preserved-paths.test",
    runtime: 4,
  },
  extensions: compose === undefined ? {} : { compose },
});

const capabilities = (
  composeSpec: ProviderCapabilities["composeSpec"],
  composePreservedPaths?: ComposePreservedPathCapabilities,
): ComposeCapabilityView =>
  composePreservedPaths === undefined ? { composeSpec } : { composeSpec, composePreservedPaths };

describe("Compose preserved paths", () => {
  test("collects each used exact path once per service", () => {
    const uses = collectComposePreservedPaths({
      web: servicePlan("web", {
        depends_on: {
          cache: { condition: "service_started", restart: true },
          database: { restart: false },
        },
        healthcheck: { start_interval: "5s" },
      }),
    });

    expect(uses).toEqual([
      { service: "web", key: "depends_on.*.restart" },
      { service: "web", key: "healthcheck.start_interval" },
    ]);
  });

  test("ignores parent objects that do not use the preserved descendants", () => {
    const uses = collectComposePreservedPaths({
      web: servicePlan("web", {
        depends_on: { database: { condition: "service_healthy" } },
        healthcheck: { start_period: "5s" },
      }),
    });

    expect(uses).toEqual([]);
  });

  test("orders uses by service and published key order", () => {
    const uses = collectComposePreservedPaths({
      zeta: servicePlan("zeta", { healthcheck: { start_interval: "2s" } }),
      alpha: servicePlan("alpha", {
        healthcheck: { start_interval: "1s" },
        depends_on: { database: { restart: true } },
      }),
    });

    expect(uses).toEqual([
      { service: "alpha", key: "depends_on.*.restart" },
      { service: "alpha", key: "healthcheck.start_interval" },
      { service: "zeta", key: "healthcheck.start_interval" },
    ]);
  });

  test("accepts only native exact support and fails closed on partial declarations", () => {
    const uses = collectComposePreservedPaths({
      web: servicePlan("web", {
        depends_on: { database: { restart: true } },
        healthcheck: { start_interval: "5s" },
      }),
    });

    expect(findUnsupportedComposePreservedPath(uses, capabilities("native"))).toEqual({
      service: "web",
      key: "depends_on.*.restart",
    });
    expect(
      findUnsupportedComposePreservedPath(
        uses,
        capabilities("portable", {
          supported: ["depends_on.*.restart", "healthcheck.start_interval"],
        }),
      ),
    ).toEqual({ service: "web", key: "depends_on.*.restart" });
    expect(
      findUnsupportedComposePreservedPath(
        uses,
        capabilities("native", { supported: ["depends_on.*.restart"] }),
      ),
    ).toEqual({ service: "web", key: "healthcheck.start_interval" });
    expect(
      findUnsupportedComposePreservedPath(
        uses,
        capabilities("native", {
          supported: ["depends_on.*.restart", "healthcheck.start_interval"],
        }),
      ),
    ).toBeUndefined();
  });
});
