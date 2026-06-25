import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";
import type { ServiceType } from "@lando/sdk/services";

import {
  ELASTICSEARCH_FEATURE_ID,
  elasticsearch8ServiceType,
  elasticsearchServiceFeature,
  elasticsearchServiceType,
} from "../src/services/elasticsearch.ts";
import { composeServicePlan } from "./support/compose-harness.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const featureOverrides = new Map([[ELASTICSEARCH_FEATURE_ID, elasticsearchServiceFeature]]);

const planElasticsearchService = async (
  serviceType: ServiceType,
  serviceDefinition: Record<string, unknown>,
  serviceName = "search",
) => {
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
  { label: "elasticsearch:8", serviceType: elasticsearch8ServiceType },
  { label: "elasticsearch", serviceType: elasticsearchServiceType },
];

describe("elasticsearch ServiceType", () => {
  for (const { label, serviceType } of serviceTypes) {
    test(`${label} plans a default Elasticsearch 8 service with persistent data volume and HTTP endpoint`, async () => {
      const plan = await planElasticsearchService(serviceType, { type: label });

      expect(plan.type).toBe("elasticsearch");
      expect(plan.artifact).toEqual({
        kind: "ref",
        ref: "docker.elastic.co/elasticsearch/elasticsearch:8.17.0",
      });
      expect(plan.command).toBeUndefined();
      expect(plan.storage).toHaveLength(1);
      expect(plan.storage[0]?.store).toBe("myapp-elasticsearch-data");
      expect(String(plan.storage[0]?.target)).toBe("/usr/share/elasticsearch/data");
      expect(plan.storage[0]?.readOnly).toBe(false);
      expect(plan.endpoints).toEqual([{ port: 9200, protocol: "tcp", name: "search" }]);
    });

    test(`${label} includes single-node and security-disabled env defaults for local dev`, async () => {
      const plan = await planElasticsearchService(serviceType, { type: label });

      expect(plan.environment).toMatchObject({
        "discovery.type": "single-node",
        "xpack.security.enabled": "false",
        "http.port": "9200",
        ES_JAVA_OPTS: "-Xms512m -Xmx512m",
      });
    });

    test(`${label} respects image and port overrides`, async () => {
      const plan = await planElasticsearchService(serviceType, {
        type: label,
        image: "docker.elastic.co/elasticsearch/elasticsearch:7.17.0",
        port: 19200,
      });

      expect(plan.artifact).toEqual({
        kind: "ref",
        ref: "docker.elastic.co/elasticsearch/elasticsearch:7.17.0",
      });
      expect(plan.endpoints[0]?.port).toBe(19200);
      expect(plan.environment["http.port"]).toBe("19200");
    });

    test(`${label} includes a curl-based command healthcheck on the cluster health endpoint`, async () => {
      const plan = await planElasticsearchService(serviceType, { type: label });

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
      const plan = await planElasticsearchService(serviceType, { type: label, port: 19200 });

      expect(plan.healthcheck?.command).toEqual([
        "bash",
        "-c",
        "curl -sf http://localhost:19200/_cluster/health",
      ]);
    });

    test(`${label} sets LANDO environment variables for service context`, async () => {
      const plan = await planElasticsearchService(serviceType, { type: label });

      expect(plan.environment).toMatchObject({
        LANDO: "ON",
        LANDO_APP_NAME: "myapp",
        LANDO_SERVICE_NAME: "search",
        LANDO_SERVICE_TYPE: "elasticsearch",
      });
    });

    test(`${label} user environment variables merge into the plan environment`, async () => {
      const plan = await planElasticsearchService(serviceType, {
        type: label,
        environment: { EXTRA_VAR: "extra" },
      });

      expect(plan.environment).toMatchObject({ EXTRA_VAR: "extra" });
    });

    test(`${label} rejects user environment that targets reserved LANDO_* keys`, async () => {
      let error: unknown;
      try {
        await planElasticsearchService(serviceType, {
          type: label,
          environment: { LANDO_SERVICE_NAME: "evil" },
        });
      } catch (cause) {
        error = cause;
      }

      expect(String(error)).toMatch(/reserved LANDO_\* keys.*LANDO_SERVICE_NAME/);
    });
  }

  test("elasticsearch:8 and elasticsearch alias resolve to the same canonical service plan", async () => {
    const primary = await planElasticsearchService(elasticsearch8ServiceType, { type: "elasticsearch:8" });
    const alias = await planElasticsearchService(elasticsearchServiceType, { type: "elasticsearch" });

    expect(primary.type).toBe("elasticsearch");
    expect(alias.type).toBe("elasticsearch");
    expect(alias).toEqual(primary);
  });

  test("uses the authored service name for the endpoint and LANDO context", async () => {
    const plan = await planElasticsearchService(
      elasticsearchServiceType,
      { type: "elasticsearch" },
      "indexer",
    );

    expect(plan.endpoints).toEqual([{ port: 9200, protocol: "tcp", name: "indexer" }]);
    expect(plan.environment).toMatchObject({
      LANDO_SERVICE_NAME: "indexer",
      LANDO_SERVICE_TYPE: "elasticsearch",
    });
  });
});
