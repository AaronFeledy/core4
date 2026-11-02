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
import { firstEndpointPort } from "./support/endpoint.ts";

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
    test(`${label} preserves authored heap options when planning`, async () => {
      // Given / When
      const plan = await planOpenSearchService(serviceType, {
        type: label,
        environment: { OPENSEARCH_JAVA_OPTS: "-Xms2g -Xmx2g" },
      });
      // Then
      expect(plan.environment.OPENSEARCH_JAVA_OPTS).toBe("-Xms2g -Xmx2g");
    });
    test(`${label} plans a default OpenSearch 2 service with persistent data volume and HTTP endpoint`, async () => {
      const plan = await planOpenSearchService(serviceType, { type: label });

      expect(plan.type).toBe("opensearch");
      expect(plan.artifact).toEqual({
        kind: "ref",
        ref: "opensearchproject/opensearch:2",
      });
      expect(plan.command).toBeUndefined();
      const volumes = plan.mounts.filter((mount) => mount.type === "volume");
      expect(volumes).toHaveLength(1);
      expect(volumes[0]?.store).toBe("myapp-opensearch-data");
      expect(String(volumes[0]?.target)).toBe("/usr/share/opensearch/data");
      expect(volumes[0]?.readOnly).toBe(false);
      expect(plan.endpoints).toEqual([
        { _tag: "internal", port: 9200, protocol: "http", name: "search", primary: true },
      ]);
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
      expect(firstEndpointPort(plan)).toBe(19200);
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

  test("opensearch aliases preserve declaration identity with otherwise identical canonical plans", async () => {
    const primary = await planOpenSearchService(opensearch2ServiceType, { type: "opensearch:2" });
    const alias = await planOpenSearchService(opensearchServiceType, { type: "opensearch" });

    expect(primary.type).toBe("opensearch");
    expect(alias.type).toBe("opensearch");
    const { serviceTypeId: primaryId, ...primaryFacts } = primary;
    const { serviceTypeId: aliasId, ...aliasFacts } = alias;
    expect(primaryId).toBe("opensearch:2");
    expect(aliasId).toBe("opensearch");
    expect(aliasFacts).toEqual(primaryFacts);
  });

  test("uses the authored service name for the endpoint", async () => {
    const plan = await planOpenSearchService(opensearchServiceType, { type: "opensearch" }, "indexer");

    expect(plan.endpoints).toEqual([
      { _tag: "internal", port: 9200, protocol: "http", name: "indexer", primary: true },
    ]);
  });

  test("service description documents Apache 2.0 licensing compared to Elasticsearch", () => {
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/Apache 2\.0/);
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/Elastic License/);
    expect(OPENSEARCH_SERVICE_DESCRIPTION).toMatch(/elasticsearch/i);
  });
  test("pins transport.port to 9300 by default and rejects primary collision", async () => {
    const plan = await planOpenSearchService(opensearchServiceType, { type: "opensearch" });
    expect(plan.environment["transport.port"]).toBe("9300");
    await expect(
      planOpenSearchService(opensearchServiceType, { type: "opensearch", port: 9300 }),
    ).rejects.toMatchObject({
      issues: [
        {
          path: ["port"],
          message: expect.stringContaining("transport listener"),
          suggestion: "Set port: to another TCP port number.",
        },
      ],
    });
  });

  test("releases 9300 when transport.port moves and accepts a valid scalar", async () => {
    const plan = await planOpenSearchService(opensearchServiceType, {
      type: "opensearch",
      port: 9300,
      environment: { "transport.port": "19300" },
    });
    expect(plan.environment["http.port"]).toBe("9300");
    expect(plan.environment["transport.port"]).toBe("19300");
    expect(firstEndpointPort(plan)).toBe(9300);
  });

  test.each(["9300-9400", "1.5", "0", "65536", "abc", ""])(
    "rejects malformed transport.port %j",
    async (value) => {
      await expect(
        planOpenSearchService(opensearchServiceType, {
          type: "opensearch",
          environment: { "transport.port": value },
        }),
      ).rejects.toMatchObject({
        issues: [
          {
            path: ["environment", "transport.port"],
            message: expect.stringMatching(/not a TCP port number|requires a literal/),
            suggestion: expect.stringContaining("1 to 65535"),
          },
        ],
      });
    },
  );

  test("does not reserve 9600 for the primary listener", async () => {
    const plan = await planOpenSearchService(opensearchServiceType, { type: "opensearch", port: 9600 });
    expect(firstEndpointPort(plan)).toBe(9600);
    expect(plan.environment["http.port"]).toBe("9600");
    expect(plan.environment["transport.port"]).toBe("9300");
  });

  test("rejects conflicting http.port native variable", async () => {
    await expect(
      planOpenSearchService(opensearchServiceType, {
        type: "opensearch",
        environment: { "http.port": "19200" },
      }),
    ).rejects.toMatchObject({
      issues: [{ path: ["environment", "http.port"], suggestion: expect.stringContaining("port:") }],
    });
  });
});
