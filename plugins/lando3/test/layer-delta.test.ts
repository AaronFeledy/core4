import { describe, expect, test } from "bun:test";
import { ConfigTranslateSourceId, type LandofileLayer } from "@lando/sdk/schema";
import { type DesiredPrefix, planLayerDeltas } from "../src/layer-delta.ts";
import { isPlainRecord, mergeLandofiles } from "../src/v4-merge.ts";

const prefix = (layer: LandofileLayer, desired: Readonly<Record<string, unknown>>): DesiredPrefix => ({
  layer,
  desired,
  sourceIds: [ConfigTranslateSourceId.make(layer)],
});
const check = (prefixes: readonly DesiredPrefix[]) => {
  const result = planLayerDeltas(prefixes);
  expect(mergeLandofiles(result.emitted.map(({ fragment }) => fragment))).toEqual(
    prefixes.at(-1)?.desired ?? {},
  );
  return result;
};
const keys = (...path: string[]) => path.map((key) => ({ kind: "key" as const, key }));
const sorted = (value: unknown): void => {
  if (Array.isArray(value)) value.forEach(sorted);
  else if (isPlainRecord(value)) {
    expect(Object.keys(value)).toEqual(Object.keys(value).sort());
    Object.values(value).forEach(sorted);
  }
};

describe("layer deltas", () => {
  test("dist-redis/local-false preserves php in dist", () => {
    const result = check([
      prefix("dist", { services: { redis: { type: "redis" }, php: { type: "php:8.3" } } }),
      prefix("local", { services: { php: { type: "php:8.3" } } }),
    ]);
    expect(result.emitted.map(({ fragment }) => fragment)).toEqual([
      { services: { php: { type: "php:8.3" } } },
      {},
    ]);
    expect(result.relocations).toEqual([
      {
        unitPath: keys("services", "redis"),
        hoistedTo: "local",
        omittedFrom: ["dist"],
        changedPrefixes: ["dist"],
        sourceIds: [ConfigTranslateSourceId.make("dist"), ConfigTranslateSourceId.make("local")],
      },
    ]);
  });
  test("nested removal hoists only the containing config map", () => {
    const result = check([
      prefix("dist", { services: { php: { type: "php:8.3", config: { a: "1", b: "2" } } } }),
      prefix("local", { services: { php: { type: "php:8.3", config: { a: "1" } } } }),
    ]);
    expect(result.emitted.map(({ fragment }) => fragment)).toEqual([
      { services: { php: { type: "php:8.3" } } },
      { services: { php: { config: { a: "1" } } } },
    ]);
    expect(result.relocations[0]?.unitPath).toEqual(keys("services", "php", "config"));
  });
  test("a removed service is dropped from earlier dependsOn lists", () => {
    const result = check([
      prefix("dist", {
        services: {
          appserver: { dependsOn: ["database", "cache"], type: "php:8.3" },
          cache: { type: "redis" },
          database: { type: "mariadb" },
        },
      }),
      prefix("local", {
        services: {
          appserver: { dependsOn: ["database"], type: "php:8.3" },
          database: { type: "mariadb" },
        },
      }),
    ]);
    const dist = result.emitted[0]?.fragment;
    const dependsOn =
      isPlainRecord(dist) && isPlainRecord(dist.services) && isPlainRecord(dist.services.appserver)
        ? dist.services.appserver.dependsOn
        : undefined;
    expect(dependsOn).toEqual(["database"]);
    expect(JSON.stringify(dist)).not.toContain("cache");
  });

  test("scalar array shrink is representable", () => {
    const result = check([prefix("dist", { items: ["a", "b"] }), prefix("local", { items: ["a"] })]);
    expect(result.relocations).toEqual([]);
    expect(result.emitted[1]?.fragment).toEqual({ items: ["a"] });
  });
  test("removed identity element hoists the whole array", () => {
    const result = check([
      prefix("dist", { items: [{ name: "a" }, { name: "b" }] }),
      prefix("local", { items: [{ name: "a" }] }),
    ]);
    expect(result.emitted[0]?.fragment).toEqual({});
    expect(result.relocations).toHaveLength(1);
    expect(result.relocations[0]?.unitPath).toEqual(keys("items"));
  });
  test("changed identity element emits alone", () => {
    const result = check([
      prefix("dist", { items: [{ name: "a", x: 1 }, { name: "b" }] }),
      prefix("local", { items: [{ name: "a", x: 2 }, { name: "b" }] }),
    ]);
    expect(result.emitted[1]?.fragment).toEqual({ items: [{ name: "a", x: 2 }] });
    expect(result.relocations).toEqual([]);
  });
  test("additive changes retain every effective prefix and minimal map deltas", () => {
    const prefixes = [
      prefix("dist", { config: { a: 1 } }),
      prefix("canonical", { config: { a: 1, b: 2 } }),
      prefix("local", { config: { a: 3, b: 2 }, extra: true }),
    ];
    const result = check(prefixes);
    prefixes.forEach(({ desired }, index) =>
      expect(mergeLandofiles(result.emitted.slice(0, index + 1).map(({ fragment }) => fragment))).toEqual(
        desired,
      ),
    );
    expect(result.emitted[1]?.fragment).toEqual({ config: { b: 2 } });
    expect(result.relocations).toEqual([]);
  });
  test("add/remove/re-add names the removal layer", () => {
    const result = check([
      prefix("dist", { service: { type: "redis" } }),
      prefix("canonical", {}),
      prefix("user", { service: { type: "redis:7" } }),
    ]);
    expect(result.relocations[0]?.hoistedTo).toBe("canonical");
    expect(result.emitted.map(({ fragment }) => fragment)).toEqual([
      {},
      {},
      { service: { type: "redis:7" } },
    ]);
  });
  test("deterministic sorted output does not mutate input", () => {
    const prefixes = [prefix("dist", { z: 1, a: { z: 2, b: 3 } }), prefix("local", { z: 1, a: { b: 4 } })];
    const before = structuredClone(prefixes);
    const result = check(prefixes);
    expect(check(prefixes)).toEqual(result);
    expect(prefixes).toEqual(before);
    for (const { fragment } of result.emitted) sorted(fragment);
  });
  test("unrelated base field stays at base", () => {
    const result = check([
      prefix("base", { name: "app" }),
      prefix("dist", { name: "app", services: { redis: {} } }),
      prefix("local", { name: "app", services: {} }),
    ]);
    expect(result.emitted.map(({ fragment }) => fragment)).toEqual([{ name: "app" }, { services: {} }, {}]);
  });
  test("removing a field inside an identity item hoists the whole array", () => {
    const result = check([
      prefix("dist", { items: [{ name: "a", config: { x: 1, y: 2 } }, { name: "b" }] }),
      prefix("local", { items: [{ name: "a", config: { x: 1 } }, { name: "b" }] }),
    ]);
    expect(result.relocations[0]?.unitPath).toEqual(keys("items"));
  });
  test("filter type replacement needs no relocation", () => {
    const result = check([
      prefix("dist", { filters: [{ name: "a", type: "redirect", to: "/" }] }),
      prefix("local", { filters: [{ name: "a", type: "addPrefix", prefix: "/x" }] }),
    ]);
    expect(result.relocations).toEqual([]);
  });
  test("provenance covers every contributing layer and deduplicates sources", () => {
    const result = check([
      prefix("dist", { config: { a: 1, b: 2 } }),
      prefix("canonical", { config: { a: 3, b: 2 } }),
      {
        ...prefix("local", { config: { a: 3 } }),
        sourceIds: [ConfigTranslateSourceId.make("dist"), ConfigTranslateSourceId.make("local")],
      },
    ]);
    expect(result.relocations[0]).toMatchObject({
      omittedFrom: ["dist", "canonical"],
      changedPrefixes: ["dist", "canonical"],
      sourceIds: ["dist", "canonical", "local"],
    });
  });
  test("empty input has an empty result", () => {
    expect(check([])).toEqual({ emitted: [], relocations: [] });
  });
  test.each([
    {
      label: "obsolete child",
      before: [{ name: "a", obsolete: true }, { name: "b" }],
      after: [{ name: "a" }, { name: "b" }],
    },
    { label: "pure reorder", before: [{ name: "a" }, { name: "b" }], after: [{ name: "b" }, { name: "a" }] },
    { label: "identity-key change", before: [{ name: "x", id: "1" }], after: [{ id: "1" }] },
    { label: "duplicate identities", before: [{ name: "a" }], after: [{ name: "a" }, { name: "a" }] },
    {
      label: "cross-key collision",
      before: [{ name: "a", id: "1" }, { id: "1" }],
      after: [{ name: "a", id: "1", x: 1 }, { id: "1" }],
    },
    { label: "clear keyed array", before: [{ name: "a" }], after: [] },
  ])("conservative whole-array relocation: $label", ({ before, after }) => {
    const result = check([prefix("dist", { items: before }), prefix("local", { items: after })]);
    expect(mergeLandofiles(result.emitted.map(({ fragment }) => fragment))).toEqual({ items: after });
    expect(result.relocations.map(({ unitPath }) => unitPath)).toEqual([keys("items")]);
    expect(result.emitted.map(({ fragment }) => fragment)).toEqual([{}, { items: after }]);
  });
  test("reintroduced item precedes a retained item exactly", () => {
    const result = check([
      prefix("dist", { items: [{ name: "a" }, { name: "b" }] }),
      prefix("canonical", { items: [{ name: "b" }] }),
      prefix("user", { items: [{ name: "a" }, { name: "b" }] }),
    ]);
    expect(result.relocations.map(({ unitPath }) => unitPath)).toEqual([keys("items"), keys("items")]);
    expect(result.relocations.map(({ hoistedTo }) => hoistedTo)).toEqual(["canonical", "user"]);
    expect(result.emitted[2]?.fragment).toEqual({ items: [{ name: "a" }, { name: "b" }] });
  });
  test("representable append emits only the new element", () => {
    const result = check([
      prefix("dist", { items: [{ name: "a" }] }),
      prefix("local", { items: [{ name: "a" }, { name: "b" }] }),
    ]);
    expect(result.relocations).toEqual([]);
    expect(result.emitted[1]?.fragment).toEqual({ items: [{ name: "b" }] });
  });
  test("empty keyed overlay leaves effective desired unchanged without relocation", () => {
    const desired = mergeLandofiles([{ items: [{ name: "a" }] }, { items: [] }]);
    const result = check([prefix("dist", { items: [{ name: "a" }] }), prefix("local", desired)]);
    expect(desired).toEqual({ items: [{ name: "a" }] });
    expect(result.relocations).toEqual([]);
    expect(result.emitted[1]?.fragment).toEqual({});
  });
  test("nested arrays hoist their enclosing array without item path segments", () => {
    const result = check([
      prefix("dist", {
        services: {
          web: { routes: [{ name: "a", filters: [{ type: "redirect", to: "/" }] }, { name: "b" }] },
        },
      }),
      prefix("local", { services: { web: { routes: [{ name: "a", filters: [] }, { name: "b" }] } } }),
    ]);
    expect(result.relocations.map(({ unitPath }) => unitPath)).toEqual([keys("services", "web", "routes")]);
  });
  test("replay accepts filter replacement despite removed nested fields", () => {
    const result = check([
      prefix("dist", {
        routes: [{ name: "a", filters: [{ name: "f", type: "redirect", to: "/", config: { old: true } }] }],
      }),
      prefix("local", {
        routes: [{ name: "a", filters: [{ name: "f", type: "addPrefix", prefix: "/new" }] }],
      }),
    ]);
    expect(result.relocations).toEqual([]);
  });
});
