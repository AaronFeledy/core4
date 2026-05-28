import { describe, expect, test } from "bun:test";

import { Effect } from "effect";

import { type HostPlatform, ProviderId } from "@lando/sdk/schema";
import type { ServiceTypeShape } from "@lando/sdk/services";
import {
  type EndpointExpectation,
  type HealthcheckExpectation,
  type ServiceContractInput,
  type ServiceContractMatrixCell,
  runServiceContract,
  runServiceContractMatrix,
} from "@lando/sdk/test";

import { elasticsearchServiceType } from "../src/services/elasticsearch.ts";
import { go122ServiceType, go123ServiceType } from "../src/services/go.ts";
import { meilisearchServiceType } from "../src/services/meilisearch.ts";
import { memcachedServiceType } from "../src/services/memcached.ts";
import { mongodbServiceType } from "../src/services/mongodb.ts";
import { opensearchServiceType } from "../src/services/opensearch.ts";
import { solrServiceType } from "../src/services/solr.ts";
import { valkeyServiceType } from "../src/services/valkey.ts";

const LANDO_PROVIDER_ID = ProviderId.make("lando");
const CONTRACT_PLATFORMS: ReadonlyArray<HostPlatform> = ["linux", "darwin", "win32", "wsl"];

interface CatalogContractEntry {
  readonly serviceType: ServiceTypeShape;
  readonly landofileServiceType: string;
  readonly expectedPlanType: string;
  readonly endpoint: EndpointExpectation;
  readonly healthcheck: HealthcheckExpectation;
  readonly defaultCredentialEnvKeys: ReadonlyArray<string>;
  readonly defaultCredentialSecretValues?: ReadonlyArray<string>;
}

const CATALOG_CONTRACT_ENTRIES: ReadonlyArray<CatalogContractEntry> = [
  {
    serviceType: go122ServiceType,
    landofileServiceType: "go:1.22",
    expectedPlanType: "go:1.22",
    endpoint: { port: 8080, protocol: "http" },
    healthcheck: { kind: "tcp", port: 8080 },
    defaultCredentialEnvKeys: [],
  },
  {
    serviceType: go123ServiceType,
    landofileServiceType: "go:1.23",
    expectedPlanType: "go:1.23",
    endpoint: { port: 8080, protocol: "http" },
    healthcheck: { kind: "tcp", port: 8080 },
    defaultCredentialEnvKeys: [],
  },
  {
    serviceType: mongodbServiceType,
    landofileServiceType: "mongodb",
    expectedPlanType: "mongodb",
    endpoint: { port: 27017, protocol: "tcp" },
    healthcheck: { kind: "tcp", port: 27017 },
    defaultCredentialEnvKeys: [
      "MONGO_INITDB_ROOT_USERNAME",
      "MONGO_INITDB_ROOT_PASSWORD",
      "MONGO_INITDB_DATABASE",
    ],
    defaultCredentialSecretValues: ["lando"],
  },
  {
    serviceType: memcachedServiceType,
    landofileServiceType: "memcached",
    expectedPlanType: "memcached",
    endpoint: { port: 11211, protocol: "tcp" },
    healthcheck: { kind: "tcp", port: 11211 },
    defaultCredentialEnvKeys: [],
  },
  {
    serviceType: valkeyServiceType,
    landofileServiceType: "valkey",
    expectedPlanType: "valkey",
    endpoint: { port: 6379, protocol: "tcp" },
    healthcheck: { kind: "tcp", port: 6379 },
    defaultCredentialEnvKeys: [],
  },
  {
    serviceType: solrServiceType,
    landofileServiceType: "solr",
    expectedPlanType: "solr",
    endpoint: { port: 8983, protocol: "http" },
    healthcheck: { kind: "http", port: 8983, path: "/solr/admin/info/system" },
    defaultCredentialEnvKeys: [],
  },
  {
    serviceType: elasticsearchServiceType,
    landofileServiceType: "elasticsearch",
    expectedPlanType: "elasticsearch",
    endpoint: { port: 9200, protocol: "tcp" },
    healthcheck: { kind: "http", port: 9200, path: "/_cluster/health" },
    defaultCredentialEnvKeys: [],
  },
  {
    serviceType: opensearchServiceType,
    landofileServiceType: "opensearch",
    expectedPlanType: "opensearch",
    endpoint: { port: 9200, protocol: "http" },
    healthcheck: { kind: "http", port: 9200, path: "/_cluster/health" },
    defaultCredentialEnvKeys: [],
  },
  {
    serviceType: meilisearchServiceType,
    landofileServiceType: "meilisearch",
    expectedPlanType: "meilisearch",
    endpoint: { port: 7700, protocol: "http" },
    healthcheck: { kind: "http", port: 7700, path: "/health" },
    defaultCredentialEnvKeys: ["MEILI_MASTER_KEY"],
    defaultCredentialSecretValues: ["lando"],
  },
];

const buildContractInput = (entry: CatalogContractEntry, platform: HostPlatform): ServiceContractInput => ({
  serviceType: entry.serviceType,
  landofileService: { type: entry.landofileServiceType },
  providerId: LANDO_PROVIDER_ID,
  platform,
  serviceName: "web",
  appName: "myapp",
  expectations: {
    type: entry.expectedPlanType,
    endpoints: [entry.endpoint],
    healthcheck: entry.healthcheck,
    defaultCredentialEnvKeys: entry.defaultCredentialEnvKeys,
    defaultCredentialSecretValues: entry.defaultCredentialSecretValues,
  },
});

const buildMatrixCells = (entry: CatalogContractEntry): ReadonlyArray<ServiceContractMatrixCell> =>
  CONTRACT_PLATFORMS.map((platform) => ({
    providerId: LANDO_PROVIDER_ID,
    platform,
    supported: true,
    factory: () => buildContractInput(entry, platform),
  }));

describe("Beta service catalog × contract suite", () => {
  for (const entry of CATALOG_CONTRACT_ENTRIES) {
    test(`${entry.serviceType.id} satisfies runServiceContract on the lando provider × linux platform`, async () => {
      await expect(
        Effect.runPromise(runServiceContract(buildContractInput(entry, "linux"))),
      ).resolves.toBeUndefined();
    });

    test(`${entry.serviceType.id} satisfies runServiceContractMatrix across every canonical host platform`, async () => {
      const report = await Effect.runPromise(
        runServiceContractMatrix({
          serviceTypeId: entry.serviceType.id,
          cells: buildMatrixCells(entry),
        }),
      );

      expect(report.serviceTypeId).toBe(entry.serviceType.id);
      expect(report.results).toHaveLength(CONTRACT_PLATFORMS.length);
      for (const result of report.results) {
        expect(result.providerId).toBe(LANDO_PROVIDER_ID);
        expect(result.outcome).toBe("passed");
      }
    });
  }

  test("catalog covers every new Beta service type from US-083..US-090", () => {
    const ids = CATALOG_CONTRACT_ENTRIES.map((entry) => entry.serviceType.id).sort();
    expect(ids).toEqual([
      "elasticsearch",
      "go:1.22",
      "go:1.23",
      "meilisearch",
      "memcached",
      "mongodb",
      "opensearch",
      "solr",
      "valkey",
    ]);
  });
});
