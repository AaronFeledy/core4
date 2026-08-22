import { describe, expect, test } from "bun:test";

import { serviceTypes } from "../src/index.ts";

const CATALOG_FAMILIES = [
  "apache",
  "compose",
  "dotnet",
  "elasticsearch",
  "go",
  "localstack",
  "mailhog",
  "mailpit",
  "mariadb",
  "meilisearch",
  "memcached",
  "minio",
  "mongodb",
  "mssql",
  "mysql",
  "nginx",
  "node",
  "opensearch",
  "php",
  "phpmyadmin",
  "postgres",
  "python",
  "rabbitmq",
  "redis",
  "ruby",
  "solr",
  "static",
  "tomcat",
  "valkey",
  "varnish",
] as const;

const ALLOWED_EXTRA_FAMILIES = ["lando"] as const;

const familyOf = (typeId: string): string => {
  const separator = typeId.indexOf(":");
  return separator === -1 ? typeId : typeId.slice(0, separator);
};

describe("catalog service-type family coverage", () => {
  test("every catalog family has at least one registered service type", () => {
    const registeredFamilies = new Set([...serviceTypes.keys()].map(familyOf));
    const missing = CATALOG_FAMILIES.filter((family) => !registeredFamilies.has(family));
    expect(missing).toEqual([]);
  });

  test("every registered family is a catalog family or the lando base", () => {
    const allowed = new Set<string>([...CATALOG_FAMILIES, ...ALLOWED_EXTRA_FAMILIES]);
    const extras = [...new Set([...serviceTypes.keys()].map(familyOf))]
      .filter((family) => !allowed.has(family))
      .sort();
    expect(extras).toEqual([]);
  });
});
