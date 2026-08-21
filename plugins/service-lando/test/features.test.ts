import { describe, expect, test } from "bun:test";

import { SERVICE_FEATURE_IDS, serviceFeatures } from "../src/index.ts";

const EXPECTED_PRIORITIES: ReadonlyArray<readonly [string, number]> = [
  ["lando.boot", 100],
  ["lando.user-id", 300],
  ["lando.storage", 500],
  ["lando.env", 700],
  ["lando.app-mount", 800],
  ["lando.healthcheck", 900],
  ["lando.certs", 1000],
  ["lando.security", 1100],
  ["lando.host-proxy", 1250],
  ["lando.user", 2000],
];

/** Catalog service features apply at 600 unless they must run after lando.env. */
const EXPECTED_CATALOG_FEATURE_PRIORITIES: Readonly<Record<string, number>> = {
  "service-lando.apache": 600,
  "service-lando.compose": 600,
  "service-lando.dotnet": 600,
  "service-lando.elasticsearch": 600,
  "service-lando.go": 600,
  "service-lando.lando": 600,
  "service-lando.localstack": 750,
  "service-lando.mailhog": 600,
  "service-lando.mailpit": 600,
  "service-lando.mariadb": 600,
  "service-lando.meilisearch": 600,
  "service-lando.memcached": 600,
  "service-lando.minio": 600,
  "service-lando.mongodb": 600,
  "service-lando.mssql": 600,
  "service-lando.mysql": 600,
  "service-lando.nginx": 600,
  "service-lando.node": 600,
  "service-lando.opensearch": 600,
  "service-lando.php": 600,
  "service-lando.phpmyadmin": 600,
  "service-lando.postgres": 600,
  "service-lando.python": 600,
  "service-lando.rabbitmq": 600,
  "service-lando.redis": 600,
  "service-lando.ruby": 600,
  "service-lando.solr": 600,
  "service-lando.static": 600,
  "service-lando.tomcat": 600,
  "service-lando.valkey": 600,
  "service-lando.varnish": 600,
};

describe("@lando/service-lando built-in feature modules", () => {
  test("publishes each built-in lando.* feature at its canonical priority", () => {
    for (const [id, priority] of EXPECTED_PRIORITIES) {
      const definition = serviceFeatures.get(id);
      expect(definition).toBeDefined();
      expect(definition?.id).toBe(id);
      expect(definition?.priority).toBe(priority);
    }
  });

  test("publishes each catalog feature at its catalog feature priority", () => {
    for (const [id, priority] of Object.entries(EXPECTED_CATALOG_FEATURE_PRIORITIES)) {
      const definition = serviceFeatures.get(id);
      expect(definition).toBeDefined();
      expect(definition?.id).toBe(id);
      expect(definition?.priority).toBe(priority);
    }
  });

  test("manifest contributes exactly the published feature ids", () => {
    const expectedIds = [
      ...EXPECTED_PRIORITIES.map(([id]) => id),
      ...Object.keys(EXPECTED_CATALOG_FEATURE_PRIORITIES),
    ];
    expect([...SERVICE_FEATURE_IDS].sort()).toEqual(expectedIds.slice().sort());
    expect([...serviceFeatures.keys()].sort()).toEqual(SERVICE_FEATURE_IDS.slice().sort());
  });
});
