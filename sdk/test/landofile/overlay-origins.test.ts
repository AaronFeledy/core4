import { expect, test } from "bun:test";
import {
  mergeValuesWithOrigins,
  override,
  reset,
  valueOriginAt,
  withValueOrigins,
} from "@lando/sdk/landofile";
import { ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";

const authored = (value: unknown, file: string) => withValueOrigins(value, (path) => ({ file, path }));

test("mapping merges retain child origins even when equal values are reauthored", () => {
  // Given
  const base = authored({ environment: { KEEP: "same", CHANGE: "same" } }, ".lando.yml");
  const local = authored({ environment: { CHANGE: "same" } }, ".lando.local.yml");
  // When
  const result = mergeValuesWithOrigins(ServiceConfig, base, local);
  // Then
  expect(result.value).toEqual({ environment: { KEEP: "same", CHANGE: "same" } });
  expect(valueOriginAt(result.origins, ["environment", "KEEP"]).source).toEqual({
    file: ".lando.yml",
    path: ["environment", "KEEP"],
  });
  expect(valueOriginAt(result.origins, ["environment", "CHANGE"]).source).toEqual({
    file: ".lando.local.yml",
    path: ["environment", "CHANGE"],
  });
});

test.each(["override", "replace"])("%s drops inherited subtree origins", (mode) => {
  // Given
  const base = authored({ environment: { OLD: "old" } }, ".lando.yml");
  const local = authored(
    { environment: mode === "override" ? override({ NEW: "new" }) : ["NEW=new"] },
    ".lando.local.yml",
  );
  // When
  const result = mergeValuesWithOrigins(ServiceConfig, base, local);
  // Then
  expect(valueOriginAt(result.origins, ["environment"]).children.has("OLD")).toBe(false);
  expect(valueOriginAt(result.origins, ["environment", mode === "override" ? "NEW" : 0]).source.file).toBe(
    ".lando.local.yml",
  );
});

test("keyed merges relocate overlay origins to their effective list index", () => {
  // Given
  const base = authored(
    {
      ports: [
        { name: "http", target: 80 },
        { name: "admin", target: 9000 },
      ],
    },
    ".lando.yml",
  );
  const local = authored(
    {
      ports: [
        { name: "admin", published: 19000 },
        { name: "debug", target: 9229 },
      ],
    },
    ".lando.local.yml",
  );
  // When
  const result = mergeValuesWithOrigins(ServiceConfig, base, local);
  // Then
  expect(result.value).toEqual({
    ports: [
      { name: "http", target: 80 },
      { name: "admin", target: 9000, published: 19000 },
      { name: "debug", target: 9229 },
    ],
  });
  expect(valueOriginAt(result.origins, ["ports", 1, "target"]).source).toEqual({
    file: ".lando.yml",
    path: ["ports", 1, "target"],
  });
  expect(valueOriginAt(result.origins, ["ports", 1, "published"]).source).toEqual({
    file: ".lando.local.yml",
    path: ["ports", 0, "published"],
  });
  expect(valueOriginAt(result.origins, ["ports", 2, "target"]).source).toEqual({
    file: ".lando.local.yml",
    path: ["ports", 1, "target"],
  });
});

test("route scheme expansion relocates untouched entries and preserves duplicate origins", () => {
  // Given
  const base = authored(
    { routes: [{ hostname: "web.test", scheme: "both", endpoint: 80 }, "other.test"] },
    ".lando.yml",
  );
  const local = authored(
    { routes: [{ hostname: "web.test", scheme: "http", endpoint: 8080 }] },
    ".lando.local.yml",
  );
  // When
  const result = mergeValuesWithOrigins(ServiceConfig, base, local);
  // Then
  expect(result.value).toEqual({
    routes: [
      { hostname: "web.test", scheme: "http", endpoint: 8080 },
      { hostname: "web.test", scheme: "https", endpoint: 80 },
      "other.test",
    ],
  });
  expect(valueOriginAt(result.origins, ["routes", 0, "endpoint"]).source.file).toBe(".lando.local.yml");
  expect(valueOriginAt(result.origins, ["routes", 1, "endpoint"]).source.path).toEqual([
    "routes",
    0,
    "endpoint",
  ]);
  expect(valueOriginAt(result.origins, ["routes", 2]).source.path).toEqual(["routes", 1]);
});

test("reset retains deletion tombstones for existing and absent keys", () => {
  // Given
  const base = authored({ environment: { OLD: "old" } }, ".lando.yml");
  const local = authored({ environment: { OLD: reset(), ABSENT: reset() } }, ".lando.local.yml");
  // When
  const removed = mergeValuesWithOrigins(ServiceConfig, base, local);
  // Then
  expect(removed.value).toEqual({ environment: {} });
  expect(valueOriginAt(removed.origins, ["environment", "OLD"])).toMatchObject({
    deleted: true,
    source: { file: ".lando.local.yml", path: ["environment", "OLD"] },
  });
  expect(valueOriginAt(removed.origins, ["environment", "ABSENT"]).deleted).toBe(true);
});

test("a reintroduced value replaces its tombstone without losing unrelated deletions", () => {
  // Given
  const removed = mergeValuesWithOrigins(
    ServiceConfig,
    authored({ environment: { OLD: "old" } }, ".lando.yml"),
    authored({ environment: { OLD: reset(), ABSENT: reset() } }, ".lando.local.yml"),
  );
  // When
  const restored = mergeValuesWithOrigins(
    ServiceConfig,
    removed,
    authored({ environment: { OLD: "new" } }, ".lando.user.yml"),
  );
  // Then
  expect(valueOriginAt(restored.origins, ["environment", "OLD"])).toMatchObject({
    deleted: false,
    source: { file: ".lando.user.yml" },
  });
  expect(valueOriginAt(restored.origins, ["environment", "ABSENT"]).deleted).toBe(true);
});

test("projections of dependency map shorthand keep the authored map location", () => {
  // Given
  const base = authored({ dependsOn: { database: "started" } }, ".lando.yml");
  const local = authored({ dependsOn: [{ service: "cache" }] }, ".lando.local.yml");
  // When
  const result = mergeValuesWithOrigins(ServiceConfig, base, local);
  // Then
  expect(valueOriginAt(result.origins, ["dependsOn", 0, "condition"]).source).toEqual({
    file: ".lando.yml",
    path: ["dependsOn", "database"],
  });
  expect(valueOriginAt(result.origins, ["dependsOn", 1, "service"]).source.path).toEqual([
    "dependsOn",
    0,
    "service",
  ]);
});

test("a root reset removes all inherited child origins", () => {
  // Given
  const base = authored({ key: "old" }, ".lando.yml");
  const local = authored(reset(), ".lando.local.yml");
  // When
  const result = mergeValuesWithOrigins(Schema.Unknown, base, local);
  // Then
  expect(result.value).toBeUndefined();
  expect(result.origins.deleted).toBe(true);
  expect(result.origins.children.size).toBe(0);
});
