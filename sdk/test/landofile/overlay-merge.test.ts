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
  test("replaces tooling cmds when a local layer overrides one of several services", () => {
    // Given inherited steps targeting different services.
    const base = {
      tooling: {
        test: {
          cmds: [
            { service: "a", cmd: "old-a" },
            { service: "b", cmd: "b" },
          ],
        },
      },
    };
    const local = { tooling: { test: { cmds: [{ service: "a", cmd: "new-a" }] } } };
    // When a local layer supplies its step list.
    const result = mergeLandofiles([base, local]);
    // Then only the local steps remain.
    expect(result).toEqual(local);
  });

  test("replaces tooling cmds when inherited steps share a service", () => {
    // Given two inherited steps targeting the same service.
    const base = {
      tooling: {
        test: {
          cmds: [
            { service: "a", cmd: "a1" },
            { service: "a", cmd: "a2" },
          ],
        },
      },
    };
    const local = { tooling: { test: { cmds: [{ service: "a", cmd: "only" }] } } };
    // When the layers merge.
    const result = mergeLandofiles([base, local]);
    // Then the second inherited step is not retained.
    expect(result).toEqual(local);
  });

  test.each([{ cmds: ["echo local", { service: "a", cmd: "only" }] }, { cmds: [] }])(
    "replaces tooling cmds with a mixed or empty local list %j",
    ({ cmds }) => {
      // Given inherited object steps and a mixed or empty overlay.
      const base = {
        tooling: {
          test: {
            cmds: [
              { service: "a", cmd: "old" },
              { service: "b", cmd: "b" },
            ],
          },
        },
      };
      const local = { tooling: { test: { cmds } } };
      // When the layers merge.
      const result = mergeLandofiles<Record<string, unknown>>([base, local]);
      // Then the overlay replaces the complete list.
      expect(result).toEqual(local);
    },
  );

  test("keeps dependsOn identity merging by service", () => {
    // Given dependencies with distinct service identities.
    const base = { dependsOn: [{ service: "a", condition: "started" }, { service: "b" }] };
    const local = { dependsOn: [{ service: "a", condition: "healthy" }] };
    // When the dependency lists merge.
    const result = mergeLandofiles([base, local]);
    // Then the matching dependency updates while the other remains.
    expect(result).toEqual({ dependsOn: [{ service: "a", condition: "healthy" }, { service: "b" }] });
  });

  test("clears base object routes when the local layer supplies an empty array", () => {
    // Given base and local layers with an explicitly empty local route list.
    const layers = [
      { services: { web: { routes: [{ hostname: "web.example.test" }] } } },
      { services: { web: { routes: [] } } },
    ];
    // When the layers merge in precedence order.
    const result = mergeLandofiles(layers);
    // Then the inherited routes are cleared.
    expect(result).toEqual({ services: { web: { routes: [] } } });
  });

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
  test.each([...ARRAY_IDENTITY_KEYS])("clears a %s-keyed array when the overlay is empty", (key) => {
    // Given an inherited identity-keyed object array.
    const left = [{ [key]: "web.example.test" }];
    // When a higher-precedence layer supplies an empty array.
    const result = mergeValues(left, []);
    // Then no inherited entry remains.
    expect(result).toEqual([]);
  });

  test("clears route filters when the overlay is empty", () => {
    // Given named and unnamed inherited route filters.
    const left = { filters: [{ name: "strip", type: "stripPrefix" }, { type: "requestHeader" }] };
    // When the overlay explicitly empties the filter list.
    const result = mergeValues(left, { filters: [] });
    // Then both filter identity kinds are cleared.
    expect(result).toEqual({ filters: [] });
  });

  test("clears scalar arrays when the overlay is empty", () => {
    // Given inherited shorthand routes.
    const left = ["web.example.test"];
    // When the overlay explicitly empties the list.
    const result = mergeValues(left, []);
    // Then the scalar array is replaced too.
    expect(result).toEqual([]);
  });

  test("keeps a non-empty object overlay when the inherited array is empty", () => {
    // Given a non-empty route overlay over an empty inherited list.
    const right = [{ hostname: "web.example.test" }];
    // When the arrays merge.
    const result = mergeValues([], right);
    // Then the overlay entries are preserved.
    expect(result).toEqual(right);
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
