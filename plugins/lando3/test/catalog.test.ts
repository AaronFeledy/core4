import { describe, expect, test } from "bun:test";
import { CATALOG, type CatalogResolution, LEGACY_TYPE_ALIASES, resolveCatalogType } from "../src/catalog.ts";
import { CAPABILITY_FRAGILE_KEYS, COMPOSE_KEY_RENAMES, dispositionOf } from "../src/compose-dispositions.ts";

const phpVersions = ["8.1", "8.2", "8.3", "8.4", "8.5", "8.6"];
const cases: ReadonlyArray<readonly [string, CatalogResolution]> = [
  ["php", { _tag: "unsupported-version", id: "php", version: "", supported: phpVersions }],
  ["php:8.3", { _tag: "resolved", id: "php", version: "8.3", v4Type: "php:8.3" }],
  ["php:7.4", { _tag: "unsupported-version", id: "php", version: "7.4", supported: phpVersions }],
  ["mysql", { _tag: "resolved", id: "mysql", v4Type: "mysql" }],
  ["mysql:8.0", { _tag: "resolved", id: "mysql", version: "8.0", v4Type: "mysql:8.0" }],
  ["mongo:7", { _tag: "resolved", id: "mongodb", version: "7", v4Type: "mongodb:7", renamedFrom: "mongo" }],
  ["mongo", { _tag: "resolved", id: "mongodb", v4Type: "mongodb", renamedFrom: "mongo" }],
  ["memcached:1.6", { _tag: "unsupported-version", id: "memcached", version: "1.6", supported: [] }],
  ["apache:2.4", { _tag: "unsupported-version", id: "apache", version: "2.4", supported: [] }],
  ["frobnicator", { _tag: "unknown-type", id: "frobnicator" }],
  ["constructor", { _tag: "unknown-type", id: "constructor" }],
  ["php:8.3:extra", { _tag: "unsupported-version", id: "php", version: "8.3:extra", supported: phpVersions }],
  ["mysql:", { _tag: "unsupported-version", id: "mysql", version: "", supported: ["8.0", "8.4", "9.7"] }],
  ["go", { _tag: "unsupported-version", id: "go", version: "", supported: ["1.22", "1.23"] }],
  ["python", { _tag: "unsupported-version", id: "python", version: "", supported: ["3.12"] }],
  ["ruby", { _tag: "unsupported-version", id: "ruby", version: "", supported: ["3.3"] }],
];

describe("local service catalog", () => {
  test.each(cases)("resolves %s against published types", (input, expected) => {
    // Given / When
    const result = resolveCatalogType(input);
    // Then
    expect(result).toEqual(expected);
  });

  test("exposes local lowering metadata when a service needs a port or config destination", () => {
    // Given / When
    const entry = CATALOG.mysql;
    // Then
    expect(entry).toEqual({
      versions: ["8.0", "8.4", "9.7"],
      containerPort: 3306,
      configKeys: { database: "server" },
      configDestination: "/etc/mysql/my.cnf",
    });
    expect(LEGACY_TYPE_ALIASES).toEqual({ mongo: "mongodb" });
    expect(Object.keys(CATALOG)).toHaveLength(31);
  });
});

describe("local Compose dispositions", () => {
  test.each([
    ["tty", "rejected"],
    ["privileged", "preserved"],
    ["volumes.consistency", "rejected"],
    ["working_dir", "normalized"],
    ["build.ssh", "rejected"],
    ["unknownkey", "unknown"],
    ["build.context", "normalized"],
    ["deploy.replicas", "rejected"],
    ["deploy.resources.limits.memory", "preserved"],
    ["build.cache_to", "rejected"],
    ["constructor", "unknown"],
    ["build.future", "unknown"],
  ] as const)("classifies %s", (path, expected) => {
    // Given / When
    const result = dispositionOf(path);
    // Then
    expect(result).toBe(expected);
  });

  test("exposes renames and provider-fragile fields for override lowering", () => {
    // Given / When
    const renames = COMPOSE_KEY_RENAMES;
    // Then
    expect(renames).toEqual({
      working_dir: "workingDirectory",
      env_file: "envFile",
      depends_on: "dependsOn",
    });
    expect([...CAPABILITY_FRAGILE_KEYS]).toEqual(["pull_policy", "gpus", "deploy"]);
  });
});
