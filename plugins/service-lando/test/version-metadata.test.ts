import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { serviceTypeVersionMatrices } from "../../../scripts/build-service-type-reference.ts";
import { serviceTypes } from "../src/index.ts";

const EXPECTED_OWNED_MATRICES = {
  elasticsearch: { "8": "docker.elastic.co/elasticsearch/elasticsearch:8.17.0" },
  go: { "1.22": "golang:1.22", "1.23": "golang:1.23" },
  mariadb: { "11.4": "mariadb:11.4" },
  meilisearch: { "1": "getmeili/meilisearch:v1.11" },
  mongodb: { "7": "mongo:7" },
  mysql: { "8.0": "mysql:8.0" },
  opensearch: { "2": "opensearchproject/opensearch:2" },
  php: {
    "8.1": "php:8.1-apache-bookworm",
    "8.2": "php:8.2-apache-bookworm",
    "8.3": "php:8.3-apache-bookworm",
    "8.4": "php:8.4-apache-bookworm",
    "8.5": "php:8.5-apache-bookworm",
  },
  postgres: { "16": "postgres:16" },
  python: { "3.12": "python:3.12-slim" },
  redis: { "7": "redis:7" },
  ruby: { "3.3": "ruby:3.3-slim" },
  solr: { "9": "solr:9" },
} as const;

describe("canonical ServiceType version metadata", () => {
  test("publishes the owned shipped version matrix with complete artifact pins", () => {
    const matrices = new Map(serviceTypeVersionMatrices().map((matrix) => [matrix.family, matrix.artifacts]));

    for (const [family, artifacts] of Object.entries(EXPECTED_OWNED_MATRICES)) {
      expect(matrices.get(family)).toEqual(artifacts);
    }
  });

  test("keeps every registered variant in a family on one canonical matrix", () => {
    for (const [id, serviceType] of serviceTypes) {
      if (serviceType.versions === undefined) continue;
      const family = id.split(":", 1)[0] ?? id;
      const matrix = serviceTypeVersionMatrices().find((candidate) => candidate.family === family);
      if (matrix === undefined) throw new Error(`Missing canonical matrix for ${family}`);
      expect(serviceType.versions).toEqual(matrix?.versions);
      expect(serviceType.artifacts).toEqual(matrix?.artifacts);
    }
  });

  test("generates the service type reference from the canonical matrices", async () => {
    const output = resolve(import.meta.dirname, "../../../docs/reference/service-types.mdx");
    const generated = await Bun.file(output).text();

    for (const [family, artifacts] of Object.entries(EXPECTED_OWNED_MATRICES)) {
      expect(generated).toContain(`| \`${family}\` |`);
      for (const artifact of Object.values(artifacts)) expect(generated).toContain(`\`${artifact}\``);
    }
  });
});
