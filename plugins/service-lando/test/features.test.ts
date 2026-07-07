import { describe, expect, test } from "bun:test";

import { SERVICE_FEATURE_IDS, serviceFeatures } from "../src/index.ts";

const EXPECTED_PRIORITIES: ReadonlyArray<readonly [string, number]> = [
  ["lando.user-id", 300],
  ["lando.storage", 500],
  ["lando.env", 700],
  ["lando.app-mount", 800],
  ["lando.healthcheck", 900],
  ["lando.user", 2000],
];

const EXPECTED_CATALOG_FEATURE_IDS: ReadonlyArray<string> = [
  "service-lando.apache",
  "service-lando.compose",
  "service-lando.elasticsearch",
  "service-lando.go",
  "service-lando.lando",
  "service-lando.mariadb",
  "service-lando.meilisearch",
  "service-lando.memcached",
  "service-lando.mongodb",
  "service-lando.mysql",
  "service-lando.nginx",
  "service-lando.node",
  "service-lando.opensearch",
  "service-lando.php",
  "service-lando.postgres",
  "service-lando.python",
  "service-lando.redis",
  "service-lando.ruby",
  "service-lando.solr",
  "service-lando.static",
  "service-lando.valkey",
];

describe("@lando/service-lando built-in feature modules", () => {
  test("publishes each built-in lando.* feature at its canonical priority", () => {
    for (const [id, priority] of EXPECTED_PRIORITIES) {
      const definition = serviceFeatures.get(id);
      expect(definition).toBeDefined();
      expect(definition?.id).toBe(id);
      expect(definition?.priority).toBe(priority);
    }
  });

  test("publishes each catalog feature at the catalog feature priority", () => {
    for (const id of EXPECTED_CATALOG_FEATURE_IDS) {
      const definition = serviceFeatures.get(id);
      expect(definition).toBeDefined();
      expect(definition?.id).toBe(id);
      expect(definition?.priority).toBe(600);
    }
  });

  test("manifest contributes exactly the published feature ids", () => {
    const expectedIds = [...EXPECTED_PRIORITIES.map(([id]) => id), ...EXPECTED_CATALOG_FEATURE_IDS];
    expect([...SERVICE_FEATURE_IDS].sort()).toEqual(expectedIds.slice().sort());
    expect([...serviceFeatures.keys()].sort()).toEqual(SERVICE_FEATURE_IDS.slice().sort());
  });
});
