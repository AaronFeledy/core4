import { describe, expect, test } from "bun:test";

import {
  ARRAY_IDENTITY_KEYS,
  identityKeyFor,
  mergeLandofiles,
  mergeValues,
  routeFilterIdentity,
  routeFilterMatches,
} from "@lando/sdk/landofile";

describe("mergeLandofiles", () => {
  test("deep-merges maps with later scalar precedence", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { appserver: { type: "node", environment: { A: "1", B: "base" } } } },
      { services: { appserver: { environment: { B: "override", C: "2" } } } },
    ]);

    expect(result).toEqual({
      services: { appserver: { type: "node", environment: { A: "1", B: "override", C: "2" } } },
    });
  });

  test("replaces scalar arrays instead of concatenating", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { web: { ports: ["80", "443"] } } },
      { services: { web: { ports: ["3000"] } } },
    ]);

    expect(result).toEqual({ services: { web: { ports: ["3000"] } } });
  });

  test("merges object arrays by the first recognized identity key", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { web: { routes: [{ hostname: "old.lndo.site", pathPrefix: "/" }] } } },
      {
        services: {
          web: { routes: [{ hostname: "old.lndo.site", scheme: "https" }, { hostname: "new.lndo.site" }] },
        },
      },
    ]);

    expect(result).toEqual({
      services: {
        web: {
          routes: [
            { hostname: "old.lndo.site", pathPrefix: "/", scheme: "https" },
            { hostname: "new.lndo.site" },
          ],
        },
      },
    });
  });

  test("replaces arrays of objects that have no recognized identity key", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { services: { web: { mounts: [{ source: "./one", target: "/one" }] } } },
      { services: { web: { mounts: [{ source: "./two", target: "/two" }] } } },
    ]);

    expect(result).toEqual({ services: { web: { mounts: [{ source: "./two", target: "/two" }] } } });
  });

  test("folds files low to high precedence so the including file wins", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { name: "base", services: { web: { type: "php" } } },
      { name: "final", services: { web: { type: "node" } } },
    ]);

    expect(result).toEqual({ name: "final", services: { web: { type: "node" } } });
  });

  test("merges route filters by name then unnamed type identity, preserving first-appearance order", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      {
        filters: [
          { type: "requestHeader", header: "X-A", value: "1" },
          { name: "strip", type: "stripPrefix", prefix: "/a" },
        ],
      },
      {
        filters: [
          { name: "strip", type: "stripPrefix", prefix: "/b" },
          { type: "requestHeader", header: "X-A", value: "2" },
        ],
      },
    ]);

    expect(result).toEqual({
      filters: [
        { type: "requestHeader", header: "X-A", value: "2" },
        { name: "strip", type: "stripPrefix", prefix: "/b" },
      ],
    });
  });

  test("never matches a named filter against an unnamed one", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { filters: [{ name: "auth", type: "requestHeader", header: "X-A", value: "1" }] },
      { filters: [{ type: "requestHeader", header: "X-A", value: "2" }] },
    ]);

    expect(result).toEqual({
      filters: [
        { name: "auth", type: "requestHeader", header: "X-A", value: "1" },
        { type: "requestHeader", header: "X-A", value: "2" },
      ],
    });
  });

  test("replaces a named filter when overlay changes its type", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      { filters: [{ name: "transform", type: "stripPrefix", prefix: "/api" }] },
      { filters: [{ name: "transform", type: "requestHeader", header: "X-Lando", value: "v4" }] },
    ]);

    expect(result).toEqual({
      filters: [{ name: "transform", type: "requestHeader", header: "X-Lando", value: "v4" }],
    });
  });

  test("does not collapse mount entries by type", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      {
        services: {
          web: {
            mounts: [
              { type: "bind", target: "/a" },
              { type: "volume", target: "/b" },
            ],
          },
        },
      },
      { services: { web: { mounts: [{ type: "bind", target: "/c" }] } } },
    ]);

    expect(result).toEqual({ services: { web: { mounts: [{ type: "bind", target: "/c" }] } } });
  });

  test("merges filters nested under routes matched by hostname", () => {
    const result = mergeLandofiles<Record<string, unknown>>([
      {
        services: {
          web: {
            routes: [
              {
                hostname: "app.lndo.site",
                filters: [
                  { type: "requestHeader", header: "X-A", value: "1" },
                  { name: "strip", type: "stripPrefix", prefix: "/a" },
                ],
              },
            ],
          },
        },
      },
      {
        services: {
          web: {
            routes: [
              {
                hostname: "app.lndo.site",
                filters: [
                  { name: "strip", type: "stripPrefix", prefix: "/b" },
                  { type: "requestHeader", header: "X-A", value: "2" },
                ],
              },
            ],
          },
        },
      },
    ]);

    expect(result).toEqual({
      services: {
        web: {
          routes: [
            {
              hostname: "app.lndo.site",
              filters: [
                { type: "requestHeader", header: "X-A", value: "2" },
                { name: "strip", type: "stripPrefix", prefix: "/b" },
              ],
            },
          ],
        },
      },
    });
  });
});

describe("routeFilterIdentity", () => {
  test("uses name when the entry has one", () => {
    const named = routeFilterIdentity({ name: "strip", type: "stripPrefix", prefix: "/a" });
    const sameName = routeFilterIdentity({ name: "strip", type: "addPrefix", prefix: "/b" });
    const otherName = routeFilterIdentity({ name: "other", type: "stripPrefix", prefix: "/a" });

    expect(named).toBeDefined();
    expect(named).toEqual(sameName);
    expect(named).not.toEqual(otherName);
  });

  test("falls back to type when the entry is unnamed", () => {
    const unnamed = routeFilterIdentity({ type: "requestHeader", header: "X-A", value: "1" });
    const sameType = routeFilterIdentity({ type: "requestHeader", header: "X-B", value: "2" });
    const otherType = routeFilterIdentity({ type: "stripPrefix", prefix: "/a" });

    expect(unnamed).toBeDefined();
    expect(unnamed).toEqual(sameType);
    expect(unnamed).not.toEqual(otherType);
  });

  test("keeps named and unnamed identities distinct even when name equals type", () => {
    expect(routeFilterIdentity({ name: "requestHeader" })).not.toEqual(
      routeFilterIdentity({ type: "requestHeader" }),
    );
  });

  test("returns undefined for non-records and entries without name or type", () => {
    expect(routeFilterIdentity("nope")).toBeUndefined();
    expect(routeFilterIdentity(null)).toBeUndefined();
    expect(routeFilterIdentity({ header: "X-A" })).toBeUndefined();
  });

  test("treats an owned undefined name as a name identity", () => {
    expect(routeFilterIdentity({ name: undefined, type: "redirect" })).toEqual({
      kind: "name",
      value: undefined,
    });
  });
});

describe("routeFilterMatches", () => {
  test("matches named filters by name", () => {
    expect(
      routeFilterMatches(
        { name: "strip", type: "stripPrefix", prefix: "/a" },
        { name: "strip", type: "addPrefix", prefix: "/b" },
      ),
    ).toBe(true);
  });

  test("matches unnamed filters by type", () => {
    expect(
      routeFilterMatches(
        { type: "requestHeader", header: "X-A", value: "1" },
        { type: "requestHeader", header: "X-B", value: "2" },
      ),
    ).toBe(true);
  });

  test("never matches a named filter against an unnamed one", () => {
    expect(
      routeFilterMatches(
        { name: "strip", type: "stripPrefix", prefix: "/a" },
        { type: "stripPrefix", prefix: "/b" },
      ),
    ).toBe(false);
  });

  test("does not match when identity is missing", () => {
    expect(routeFilterMatches({ type: "requestHeader" }, { header: "X-A" })).toBe(false);
    expect(routeFilterMatches("nope", { type: "requestHeader" })).toBe(false);
  });
});

describe("mergeValues identity edges", () => {
  test("empty right array preserves a keyed left array", () => {
    expect(mergeValues([{ name: "a" }], [])).toEqual([{ name: "a" }]);
  });

  test("empty right array clears an unkeyed left array", () => {
    expect(mergeValues([{ value: "a" }], [])).toEqual([]);
  });

  test.each([
    [[1, 2], [1]],
    [[{ name: "a" }, 2], [{ name: "b" }]],
    [[{ name: "a" }], [{ other: "b" }]],
    [[{ other: "a" }], [{ name: "b" }]],
  ])("replaces nonidentity arrays %j with %j", (left, right) => {
    expect(mergeValues(left, right)).toEqual(right);
  });

  test.each([...ARRAY_IDENTITY_KEYS])("merges by %s", (key) => {
    expect(mergeValues([{ [key]: "a", x: 1 }], [{ [key]: "a", y: 2 }, { [key]: "b" }])).toEqual([
      { [key]: "a", x: 1, y: 2 },
      { [key]: "b" },
    ]);
  });

  test("selects the first owned identity and matches using the overlay key", () => {
    expect(identityKeyFor({ name: "a", id: "b" })).toBe("name");
    expect(mergeValues([{ name: "a", id: "b" }], [{ id: "b", x: 1 }])).toEqual([
      { name: "a", id: "b", x: 1 },
    ]);
  });

  test("replaces filters lacking identity", () => {
    expect(mergeValues([{ type: "redirect" }], [{}], "filters")).toEqual([{}]);
  });
});
