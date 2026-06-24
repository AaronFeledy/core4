import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { OPENSEARCH_SERVICE_DESCRIPTION, opensearch2ServiceType } from "../src/services/opensearch.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planOpenSearchService = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { search: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("search")];
  if (service === undefined) throw new Error("search service missing");

  return opensearch2ServiceType.__legacyToServicePlan({
    name: "search",
    service,
    appRoot: "/srv/apps/myapp",
    metadata,
  });
};

describe("opensearch ServiceType", () => {
  test("plans a default OpenSearch 2 service with persistent data volume and HTTP endpoint", () => {
    const plan = planOpenSearchService({ type: "opensearch" });

    expect(plan.type).toBe("opensearch");
    expect(plan.artifact).toEqual({
      kind: "ref",
      ref: "opensearchproject/opensearch:2",
    });
    expect(plan.command).toBeUndefined();
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-opensearch-data");
    expect(String(plan.storage[0]?.target)).toBe("/usr/share/opensearch/data");
    expect(plan.endpoints).toEqual([{ port: 9200, protocol: "http", name: "search" }]);
  });

  test("includes single-node and security-disabled env defaults for local dev", () => {
    const plan = planOpenSearchService({ type: "opensearch" });

    expect(plan.environment["discovery.type"]).toBe("single-node");
    expect(plan.environment.DISABLE_SECURITY_PLUGIN).toBe("true");
    expect(plan.environment.DISABLE_INSTALL_DEMO_CONFIG).toBe("true");
    expect(plan.environment["http.port"]).toBe("9200");
    expect(plan.environment.OPENSEARCH_JAVA_OPTS).toBe("-Xms512m -Xmx512m");
  });

  test("respects image and port overrides", () => {
    const plan = planOpenSearchService({
      type: "opensearch",
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

  test("includes a curl-based command healthcheck on the cluster health endpoint", () => {
    const plan = planOpenSearchService({ type: "opensearch" });

    expect(plan.healthcheck).toEqual({
      kind: "command",
      command: ["bash", "-c", "curl -sf http://localhost:9200/_cluster/health"],
      intervalSeconds: 15,
      timeoutSeconds: 10,
      retries: 5,
      startPeriodSeconds: 90,
    });
  });

  test("healthcheck command tracks the overridden port", () => {
    const plan = planOpenSearchService({ type: "opensearch", port: 19200 });

    expect(plan.healthcheck?.command).toEqual([
      "bash",
      "-c",
      "curl -sf http://localhost:19200/_cluster/health",
    ]);
  });

  test("sets LANDO environment variables for service context", () => {
    const plan = planOpenSearchService({ type: "opensearch" });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("search");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("opensearch");
  });

  test("user environment variables merge into the plan environment", () => {
    const plan = planOpenSearchService({
      type: "opensearch",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment.EXTRA_VAR).toBe("extra");
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    expect(() =>
      planOpenSearchService({ type: "opensearch", environment: { LANDO_SERVICE_NAME: "evil" } }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_SERVICE_NAME/);
  });

  test("service description documents Apache 2.0 licensing compared to Elasticsearch", () => {
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/Apache 2\.0/);
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/Elastic License/);
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/elasticsearch/i);
  });
});
