import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import {
  MEILISEARCH_DEFAULT_MASTER_KEY,
  MEILISEARCH_SERVICE_DESCRIPTION,
  meilisearch1ServiceType,
} from "../src/services/meilisearch.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planMeiliService = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { search: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("search")];
  if (service === undefined) throw new Error("search service missing");

  return meilisearch1ServiceType.__legacyToServicePlan({
    name: "search",
    service,
    appRoot: "/srv/apps/myapp",
    metadata,
  });
};

describe("meilisearch ServiceType", () => {
  test("plans a default Meilisearch 1 service with persistent data volume and HTTP endpoint", () => {
    const plan = planMeiliService({ type: "meilisearch" });

    expect(plan.type).toBe("meilisearch");
    expect(plan.artifact).toEqual({
      kind: "ref",
      ref: "getmeili/meilisearch:v1.11",
    });
    expect(plan.command).toBeUndefined();
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-meilisearch-data");
    expect(String(plan.storage[0]?.target)).toBe("/meili_data");
    expect(plan.endpoints).toEqual([{ port: 7700, protocol: "http", name: "search" }]);
  });

  test("seeds a deterministic dev master key and disables analytics by default", () => {
    const plan = planMeiliService({ type: "meilisearch" });

    expect(plan.environment.MEILI_MASTER_KEY).toBe(MEILISEARCH_DEFAULT_MASTER_KEY);
    expect(plan.environment.MEILI_NO_ANALYTICS).toBe("true");
    expect(plan.environment.MEILI_ENV).toBe("development");
    expect(plan.environment.MEILI_HTTP_ADDR).toBe("0.0.0.0:7700");
  });

  test("respects image and port overrides", () => {
    const plan = planMeiliService({
      type: "meilisearch",
      image: "getmeili/meilisearch:v1.10",
      port: 17700,
    });

    expect(plan.artifact).toEqual({
      kind: "ref",
      ref: "getmeili/meilisearch:v1.10",
    });
    expect(plan.endpoints[0]?.port).toBe(17700);
    expect(plan.environment.MEILI_HTTP_ADDR).toBe("0.0.0.0:17700");
  });

  test("includes a curl-based command healthcheck on the /health endpoint", () => {
    const plan = planMeiliService({ type: "meilisearch" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["sh", "-c", "curl -sf http://localhost:7700/health"],
      intervalSeconds: 10,
      timeoutSeconds: 5,
      retries: 5,
      startPeriodSeconds: 30,
    });
  });

  test("healthcheck command tracks the overridden port", () => {
    const plan = planMeiliService({ type: "meilisearch", port: 17700 });

    expect(plan.healthcheck?.command).toEqual(["sh", "-c", "curl -sf http://localhost:17700/health"]);
  });

  test("sets LANDO environment variables for service context", () => {
    const plan = planMeiliService({ type: "meilisearch" });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("search");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("meilisearch");
  });

  test("user environment variables merge into the plan environment", () => {
    const plan = planMeiliService({
      type: "meilisearch",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment.EXTRA_VAR).toBe("extra");
  });

  test("user-supplied MEILI_MASTER_KEY overrides the default", () => {
    const plan = planMeiliService({
      type: "meilisearch",
      environment: { MEILI_MASTER_KEY: "my-custom-key" },
    });

    expect(plan.environment.MEILI_MASTER_KEY).toBe("my-custom-key");
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    expect(() =>
      planMeiliService({ type: "meilisearch", environment: { LANDO_SERVICE_NAME: "evil" } }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_SERVICE_NAME/);
  });

  test("service description documents MIT licensing, analytics opt-out, and master key redaction", () => {
    expect(MEILISEARCH_SERVICE_DESCRIPTION).toMatch(/MIT/);
    expect(MEILISEARCH_SERVICE_DESCRIPTION).toMatch(/MEILI_NO_ANALYTICS=true/);
    expect(MEILISEARCH_SERVICE_DESCRIPTION).toMatch(/redacted/i);
  });
});
