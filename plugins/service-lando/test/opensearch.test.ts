import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName, type ServicePlan } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  OPENSEARCH_FEATURE_ID,
  OPENSEARCH_SERVICE_DESCRIPTION,
  opensearch2ServiceType,
  opensearchServiceFeature,
  opensearchServiceType,
} from "../src/services/opensearch.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[OPENSEARCH_FEATURE_ID, opensearchServiceFeature]]);

const planOpenSearchService = async (
  serviceType: ServiceType,
  serviceDefinition: Record<string, unknown>,
  serviceName = "search",
): Promise<ServicePlan> => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { [serviceName]: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make(serviceName)];
  if (service === undefined) throw new Error(`${serviceName} service missing`);

  return composeServicePlan({
    serviceType,
    service,
    appRoot: "/srv/apps/myapp",
    appName: "myapp",
    serviceName,
    metadata,
    featureOverrides,
  });
};

const serviceTypes: ReadonlyArray<{ readonly label: string; readonly serviceType: ServiceType }> = [
  { label: "opensearch:2", serviceType: opensearch2ServiceType },
  { label: "opensearch", serviceType: opensearchServiceType },
];

describe("opensearch ServiceType", () => {
  for (const { label, serviceType } of serviceTypes) {
    test(`${label} plans a default OpenSearch 2 service with persistent data volume and HTTP endpoint`, async () => {
      const plan = await planOpenSearchService(serviceType, { type: label });

      expect(plan.type).toBe("opensearch");
      expect(plan.artifact).toEqual({
        kind: "ref",
        ref: "opensearchproject/opensearch:2",
      });
      expect(plan.command).toBeUndefined();
      expect(plan.storage).toHaveLength(1);
      expect(plan.storage[0]?.store).toBe("myapp-opensearch-data");
      expect(String(plan.storage[0]?.target)).toBe("/usr/share/opensearch/data");
      expect(plan.storage[0]?.readOnly).toBe(false);
      expect(plan.endpoints).toEqual([{ _tag: "internal", port: 9200, protocol: "http", name: "search" }]);
    });

    test(`${label} includes single-node and security-disabled env defaults for local dev`, async () => {
      const plan = await planOpenSearchService(serviceType, { type: label });

      expect(plan.environment).toMatchObject({
        "discovery.type": "single-node",
        DISABLE_SECURITY_PLUGIN: "true",
        DISABLE_INSTALL_DEMO_CONFIG: "true",
        "http.port": "9200",
        OPENSEARCH_JAVA_OPTS: "-Xms512m -Xmx512m",
      });
    });

    test(`${label} respects image and port overrides`, async () => {
      const plan = await planOpenSearchService(serviceType, {
        type: label,
        image: "opensearchproject/opensearch:2.18.0",
        port: 19200,
      });

      expect(plan.artifact).toEqual({
        kind: "ref",
        ref: "opensearchproject/opensearch:2.18.0",
      });
      expect(plan.endpoints[0]?.port).toBe(19200);
      expect(plan.environment["http.port"]).toBe("19200");
    });

    test(`${label} includes a curl-based command healthcheck on the cluster health endpoint`, async () => {
      const plan = await planOpenSearchService(serviceType, { type: label });

      expect(plan.healthcheck).toEqual({
        kind: "command",
        command: ["bash", "-c", "curl -sf http://localhost:9200/_cluster/health"],
        intervalSeconds: 15,
        timeoutSeconds: 10,
        retries: 5,
        startPeriodSeconds: 90,
      });
    });

    test(`${label} healthcheck command tracks the overridden port`, async () => {
      const plan = await planOpenSearchService(serviceType, { type: label, port: 19200 });

      expect(plan.healthcheck?.command).toEqual([
        "bash",
        "-c",
        "curl -sf http://localhost:19200/_cluster/health",
      ]);
    });

    test(`${label} user environment variables merge into the plan environment`, async () => {
      const plan = await planOpenSearchService(serviceType, {
        type: label,
        environment: { EXTRA_VAR: "extra" },
      });

      expect(plan.environment).toMatchObject({ EXTRA_VAR: "extra" });
    });
  }

  test("opensearch:2 and opensearch alias resolve to the same canonical service plan", async () => {
    const primary = await planOpenSearchService(opensearch2ServiceType, { type: "opensearch:2" });
    const alias = await planOpenSearchService(opensearchServiceType, { type: "opensearch" });

    expect(primary.type).toBe("opensearch");
    expect(alias.type).toBe("opensearch");
    expect(alias).toEqual(primary);
  });

  test("uses the authored service name for the endpoint", async () => {
    const plan = await planOpenSearchService(opensearchServiceType, { type: "opensearch" }, "indexer");

    expect(plan.endpoints).toEqual([{ _tag: "internal", port: 9200, protocol: "http", name: "indexer" }]);
  });

  test("service description documents Apache 2.0 licensing compared to Elasticsearch", () => {
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/Apache 2\.0/);
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/Elastic License/);
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/elasticsearch/i);
  });
});
