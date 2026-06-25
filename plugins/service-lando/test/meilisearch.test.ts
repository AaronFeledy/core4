import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  MEILISEARCH_DEFAULT_MASTER_KEY,
  MEILISEARCH_FEATURE_ID,
  MEILISEARCH_SERVICE_DESCRIPTION,
  meilisearch1ServiceType,
  meilisearchServiceFeature,
  meilisearchServiceType,
} from "../src/services/meilisearch.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[MEILISEARCH_FEATURE_ID, meilisearchServiceFeature]]);

const planMeiliService = async (serviceType: ServiceType, serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { search: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("search")];
  if (service === undefined) throw new Error("search service missing");

  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName: "search",
    metadata,
    featureOverrides,
  });
};

describe("meilisearch ServiceType", () => {
  for (const [id, serviceType] of [
    ["meilisearch:1", meilisearch1ServiceType],
    ["meilisearch", meilisearchServiceType],
  ] as const) {
    describe(id, () => {
      test("plans a default Meilisearch service with persistent data volume and HTTP endpoint", async () => {
        const plan = await planMeiliService(serviceType, { type: id });

        expect(plan.type).toBe("meilisearch");
        expect(plan.artifact).toEqual({
          kind: "ref",
          ref: "getmeili/meilisearch:v1.11",
        });
        expect(plan.command).toBeUndefined();
        expect(plan.storage).toHaveLength(1);
        expect(plan.storage[0]?.store).toBe("myapp-meilisearch-data");
        expect(String(plan.storage[0]?.target)).toBe("/meili_data");
        expect(plan.storage[0]?.readOnly).toBe(false);
        expect(plan.endpoints).toEqual([{ port: 7700, protocol: "http", name: "search" }]);
      });

      test("seeds a deterministic dev master key and disables analytics by default", async () => {
        const plan = await planMeiliService(serviceType, { type: id });

        expect(plan.environment).toMatchObject({
          MEILI_MASTER_KEY: MEILISEARCH_DEFAULT_MASTER_KEY,
          MEILI_NO_ANALYTICS: "true",
          MEILI_ENV: "development",
          MEILI_HTTP_ADDR: "0.0.0.0:7700",
        });
      });

      test("respects image and port overrides", async () => {
        const plan = await planMeiliService(serviceType, {
          type: id,
          image: "getmeili/meilisearch:v1.10",
          port: 17700,
        });

        expect(plan.artifact).toEqual({
          kind: "ref",
          ref: "getmeili/meilisearch:v1.10",
        });
        expect(plan.endpoints).toEqual([{ port: 17700, protocol: "http", name: "search" }]);
        expect(plan.environment).toMatchObject({ MEILI_HTTP_ADDR: "0.0.0.0:17700" });
      });

      test("includes a curl-based command healthcheck on the /health endpoint", async () => {
        const plan = await planMeiliService(serviceType, { type: id });

        expect(plan.healthcheck).toEqual({
          kind: "command",
          command: ["sh", "-c", "curl -sf http://localhost:7700/health"],
          intervalSeconds: 10,
          timeoutSeconds: 5,
          retries: 5,
          startPeriodSeconds: 30,
        });
      });

      test("healthcheck command tracks the overridden port", async () => {
        const plan = await planMeiliService(serviceType, { type: id, port: 17700 });

        expect(plan.healthcheck?.command).toEqual(["sh", "-c", "curl -sf http://localhost:17700/health"]);
      });

      test("propagates authored process fields and dependencies", async () => {
        const plan = await planMeiliService(serviceType, {
          type: id,
          command: ["meilisearch", "--http-addr", "0.0.0.0:7700"],
          entrypoint: ["/bin/sh", "-c"],
          workingDirectory: "/meili_data",
          user: "1000:1000",
          dependsOn: ["api"],
        });

        expect(plan.command).toEqual(["meilisearch", "--http-addr", "0.0.0.0:7700"]);
        expect(plan.entrypoint).toEqual(["/bin/sh", "-c"]);
        expect(`${plan.workingDirectory}`).toBe("/meili_data");
        expect(plan.user).toBe("1000:1000");
        expect(plan.dependsOn).toHaveLength(1);
        expect(`${plan.dependsOn[0]?.service}`).toBe("api");
        expect(plan.dependsOn[0]?.condition).toBe("started");
      });

      test("user environment variables merge into the plan environment", async () => {
        const plan = await planMeiliService(serviceType, {
          type: id,
          environment: { EXTRA_VAR: "extra" },
        });

        expect(plan.environment).toMatchObject({ EXTRA_VAR: "extra" });
      });
    });
  }

  test("service description documents MIT licensing, analytics opt-out, and master key redaction", () => {
    expect(MEILISEARCH_SERVICE_DESCRIPTION).toMatch(/MIT/);
    expect(MEILISEARCH_SERVICE_DESCRIPTION).toMatch(/MEILI_NO_ANALYTICS=true/);
    expect(MEILISEARCH_SERVICE_DESCRIPTION).toMatch(/redacted/i);
  });
});
