import { describe, expect, test } from "bun:test";
import { Schema } from "effect";

import { LandofileShape, ServiceName } from "@lando/sdk/schema";

import { elasticsearch8ServiceType } from "../src/services/elasticsearch.ts";

const metadata = {
  resolvedAt: "2026-05-28T00:00:00Z",
  source: "/srv/apps/myapp/.lando.yml",
  runtime: 4 as const,
};

const planElasticsearchService = (serviceDefinition: Record<string, unknown>) => {
  const landofile = Schema.decodeUnknownSync(LandofileShape)({
    name: "myapp",
    services: { search: serviceDefinition },
  });
  const service = landofile.services?.[ServiceName.make("search")];
  if (service === undefined) throw new Error("search service missing");

  return elasticsearch8ServiceType.toServicePlan({
    name: "search",
    service,
    appRoot: "/srv/apps/myapp",
    metadata,
  });
};

describe("elasticsearch ServiceType", () => {
  test("plans a default Elasticsearch 8 service with persistent data volume and HTTP endpoint", () => {
    const plan = planElasticsearchService({ type: "elasticsearch" });

    expect(plan.type).toBe("elasticsearch");
    expect(plan.artifact).toEqual({ kind: "ref", ref: "elasticsearch:8" });
    expect(plan.command).toBeUndefined();
    expect(plan.storage).toHaveLength(1);
    expect(plan.storage[0]?.store).toBe("myapp-elasticsearch-data");
    expect(String(plan.storage[0]?.target)).toBe("/usr/share/elasticsearch/data");
    expect(plan.endpoints).toEqual([{ port: 9200, protocol: "tcp", name: "search" }]);
  });

  test("includes single-node and security-disabled env defaults for local dev", () => {
    const plan = planElasticsearchService({ type: "elasticsearch" });

    expect(plan.environment["discovery.type"]).toBe("single-node");
    expect(plan.environment["xpack.security.enabled"]).toBe("false");
    expect(plan.environment.ES_JAVA_OPTS).toBe("-Xms512m -Xmx512m");
  });

  test("respects image and port overrides", () => {
    const plan = planElasticsearchService({
      type: "elasticsearch",
      image: "elasticsearch:7.17.0",
      port: 19200,
    });

    expect(plan.artifact).toEqual({ kind: "ref", ref: "elasticsearch:7.17.0" });
    expect(plan.endpoints[0]?.port).toBe(19200);
  });

  test("includes a curl-based command healthcheck on the cluster health endpoint", () => {
    const plan = planElasticsearchService({ type: "elasticsearch" });

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
    const plan = planElasticsearchService({ type: "elasticsearch", port: 19200 });

    expect(plan.healthcheck?.command).toEqual([
      "bash",
      "-c",
      "curl -sf http://localhost:19200/_cluster/health",
    ]);
  });

  test("sets LANDO environment variables for service context", () => {
    const plan = planElasticsearchService({ type: "elasticsearch" });

    expect(plan.environment.LANDO).toBe("ON");
    expect(plan.environment.LANDO_APP_NAME).toBe("myapp");
    expect(plan.environment.LANDO_SERVICE_NAME).toBe("search");
    expect(plan.environment.LANDO_SERVICE_TYPE).toBe("elasticsearch");
  });

  test("user environment variables merge into the plan environment", () => {
    const plan = planElasticsearchService({
      type: "elasticsearch",
      environment: { EXTRA_VAR: "extra" },
    });

    expect(plan.environment.EXTRA_VAR).toBe("extra");
  });

  test("rejects user environment that targets reserved LANDO_* keys", () => {
    expect(() =>
      planElasticsearchService({ type: "elasticsearch", environment: { LANDO_SERVICE_NAME: "evil" } }),
    ).toThrow(/reserved LANDO_\* keys.*LANDO_SERVICE_NAME/);
  });
});
