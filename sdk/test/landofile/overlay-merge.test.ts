import { describe, expect, test } from "bun:test";

import {
  mergeLandofiles,
  mergeValues,
  override,
  reset,
  resolveLayerMergeRule,
  routeFilterIdentity,
  routeFilterMatches,
} from "@lando/sdk/landofile";
import { RouteObjectInput, ServiceConfig } from "@lando/sdk/schema";
import { Schema } from "effect";

const mergeRouteFragments = (layers: ReadonlyArray<Record<string, unknown>>): unknown =>
  layers.reduce<unknown>((left, right) => mergeValues(RouteObjectInput, left, right), {});
const identities = [
  { field: "endpoints", key: "name" },
  { field: "logs", key: "id" },
  { field: "routes", key: "hostname" },
  { field: "dependsOn", key: "service" },
] as const;

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
      const result = mergeLandofiles([base, local]);
      // Then the overlay replaces the complete list.
      expect(result).toEqual(local);
    },
  );

  test("keeps dependsOn identity merging by service", () => {
    // Given dependencies with distinct service identities.
    const base = { dependsOn: [{ service: "a", condition: "started" }, { service: "b" }] };
    const local = { dependsOn: [{ service: "a", condition: "healthy" }] };
    // When the dependency lists merge.
    const result = mergeValues(ServiceConfig, base, local);
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
    const result = mergeLandofiles([
      { services: { appserver: { type: "node", environment: { A: "1", B: "base" } } } },
      { services: { appserver: { environment: { B: "override", C: "2" } } } },
    ]);

    expect(result).toEqual({
      services: { appserver: { type: "node", environment: { A: "1", B: "override", C: "2" } } },
    });
  });

  test("replaces scalar arrays instead of concatenating", () => {
    const result = mergeLandofiles([
      { services: { web: { ports: ["80", "443"] } } },
      { services: { web: { ports: ["3000"] } } },
    ]);

    expect(result).toEqual({ services: { web: { ports: ["3000"] } } });
  });

  test("merges routes by the declared scheme, hostname and path identity", () => {
    const result = mergeLandofiles([
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
    const result = mergeLandofiles([
      { services: { web: { mounts: [{ source: "./one", target: "/one" }] } } },
      { services: { web: { mounts: [{ source: "./two", target: "/two" }] } } },
    ]);

    expect(result).toEqual({ services: { web: { mounts: [{ source: "./two", target: "/two" }] } } });
  });

  test("folds files low to high precedence so the including file wins", () => {
    const result = mergeLandofiles([
      { name: "base", services: { web: { type: "php" } } },
      { name: "final", services: { web: { type: "node" } } },
    ]);

    expect(result).toEqual({ name: "final", services: { web: { type: "node" } } });
  });

  test("merges route filters by name then unnamed kind identity, preserving first-appearance order", () => {
    const result = mergeRouteFragments([
      {
        filters: [
          { kind: "requestHeader", header: "X-A", value: "1" },
          { name: "strip", kind: "stripPrefix", prefix: "/a" },
        ],
      },
      {
        filters: [
          { name: "strip", kind: "stripPrefix", prefix: "/b" },
          { kind: "requestHeader", header: "X-A", value: "2" },
        ],
      },
    ]);

    expect(result).toEqual({
      filters: [
        { kind: "requestHeader", header: "X-A", value: "2" },
        { name: "strip", kind: "stripPrefix", prefix: "/b" },
      ],
    });
  });

  test("never matches a named filter against an unnamed one", () => {
    const result = mergeRouteFragments([
      { filters: [{ name: "auth", kind: "requestHeader", header: "X-A", value: "1" }] },
      { filters: [{ kind: "requestHeader", header: "X-A", value: "2" }] },
    ]);

    expect(result).toEqual({
      filters: [
        { name: "auth", kind: "requestHeader", header: "X-A", value: "1" },
        { kind: "requestHeader", header: "X-A", value: "2" },
      ],
    });
  });

  test("replaces a named filter when overlay changes its kind", () => {
    const result = mergeRouteFragments([
      { filters: [{ name: "transform", kind: "stripPrefix", prefix: "/api" }] },
      { filters: [{ name: "transform", kind: "requestHeader", header: "X-Lando", value: "v4" }] },
    ]);

    expect(result).toEqual({
      filters: [{ name: "transform", kind: "requestHeader", header: "X-Lando", value: "v4" }],
    });
  });

  test("does not collapse mount entries by type", () => {
    const result = mergeLandofiles([
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
    const result = mergeLandofiles([
      {
        services: {
          web: {
            routes: [
              {
                hostname: "app.lndo.site",
                filters: [
                  { kind: "requestHeader", header: "X-A", value: "1" },
                  { name: "strip", kind: "stripPrefix", prefix: "/a" },
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
                  { name: "strip", kind: "stripPrefix", prefix: "/b" },
                  { kind: "requestHeader", header: "X-A", value: "2" },
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
                { kind: "requestHeader", header: "X-A", value: "2" },
                { name: "strip", kind: "stripPrefix", prefix: "/b" },
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
    const named = routeFilterIdentity({ name: "strip", kind: "stripPrefix", prefix: "/a" });
    const sameName = routeFilterIdentity({ name: "strip", kind: "addPrefix", prefix: "/b" });
    const otherName = routeFilterIdentity({ name: "other", kind: "stripPrefix", prefix: "/a" });

    expect(named).toBeDefined();
    expect(named).toEqual(sameName);
    expect(named).not.toEqual(otherName);
  });

  test("falls back to kind when the entry is unnamed", () => {
    const unnamed = routeFilterIdentity({ kind: "requestHeader", header: "X-A", value: "1" });
    const sameType = routeFilterIdentity({ kind: "requestHeader", header: "X-B", value: "2" });
    const otherType = routeFilterIdentity({ kind: "stripPrefix", prefix: "/a" });

    expect(unnamed).toBeDefined();
    expect(unnamed).toEqual(sameType);
    expect(unnamed).not.toEqual(otherType);
  });

  test("keeps named and unnamed identities distinct even when name equals kind", () => {
    expect(routeFilterIdentity({ name: "requestHeader" })).not.toEqual(
      routeFilterIdentity({ kind: "requestHeader" }),
    );
  });

  test("returns undefined for non-records and entries without name or kind", () => {
    expect(routeFilterIdentity("nope")).toBeUndefined();
    expect(routeFilterIdentity(null)).toBeUndefined();
    expect(routeFilterIdentity({ header: "X-A" })).toBeUndefined();
  });

  test("treats an owned undefined name as a name identity", () => {
    expect(routeFilterIdentity({ name: undefined, kind: "redirect" })).toEqual({
      kind: "name",
      value: undefined,
    });
  });
});

describe("routeFilterMatches", () => {
  test("matches named filters by name", () => {
    expect(
      routeFilterMatches(
        { name: "strip", kind: "stripPrefix", prefix: "/a" },
        { name: "strip", kind: "addPrefix", prefix: "/b" },
      ),
    ).toBe(true);
  });

  test("matches unnamed filters by kind", () => {
    expect(
      routeFilterMatches(
        { kind: "requestHeader", header: "X-A", value: "1" },
        { kind: "requestHeader", header: "X-B", value: "2" },
      ),
    ).toBe(true);
  });

  test("never matches a named filter against an unnamed one", () => {
    expect(
      routeFilterMatches(
        { name: "strip", kind: "stripPrefix", prefix: "/a" },
        { kind: "stripPrefix", prefix: "/b" },
      ),
    ).toBe(false);
  });

  test("does not match when identity is missing", () => {
    expect(routeFilterMatches({ kind: "requestHeader" }, { header: "X-A" })).toBe(false);
    expect(routeFilterMatches("nope", { kind: "requestHeader" })).toBe(false);
  });
});

describe("mergeValues identity edges", () => {
  test("retains sequential matching for repeated named route filters", () => {
    const left = { filters: [{ name: "a", kind: "stripPrefix", prefix: "/base" }] };
    const right = {
      filters: [
        { name: "a", kind: "stripPrefix", prefix: "/first" },
        { name: "a", kind: "stripPrefix", prefix: "/last" },
      ],
    };
    expect(mergeValues(RouteObjectInput, left, right)).toEqual({
      filters: [{ name: "a", kind: "stripPrefix", prefix: "/last" }],
    });
  });
  test.each([...identities])("clears a $field array when the overlay is empty", ({ key, field }) => {
    // Given an inherited identity-keyed object array.
    const left = [{ [key]: "web.example.test" }];
    // When a higher-precedence layer supplies an empty array.
    const result = mergeValues(ServiceConfig, left, [], [field]);
    // Then no inherited entry remains.
    expect(result).toEqual([]);
  });

  test("clears route filters when the overlay is empty", () => {
    // Given named and unnamed inherited route filters.
    const left = { filters: [{ name: "strip", kind: "stripPrefix" }, { kind: "requestHeader" }] };
    // When the overlay explicitly empties the filter list.
    const result = mergeValues(RouteObjectInput, left, { filters: [] });
    // Then both filter identity kinds are cleared.
    expect(result).toEqual({ filters: [] });
  });

  test("clears scalar arrays when the overlay is empty", () => {
    // Given inherited shorthand routes.
    const left = ["web.example.test"];
    // When the overlay explicitly empties the list.
    const result = mergeValues(Schema.Unknown, left, []);
    // Then the scalar array is replaced too.
    expect(result).toEqual([]);
  });

  test("keeps a non-empty object overlay when the inherited array is empty", () => {
    // Given a non-empty route overlay over an empty inherited list.
    const right = [{ hostname: "web.example.test" }];
    // When the arrays merge.
    const result = mergeValues(ServiceConfig, [], right, ["routes"]);
    // Then the overlay entries are preserved.
    expect(result).toEqual(right);
  });

  test("empty right array clears an unkeyed left array", () => {
    expect(mergeValues(Schema.Unknown, [{ value: "a" }], [])).toEqual([]);
  });

  test.each([
    [[1, 2], [1]],
    [[{ name: "a" }, 2], [{ name: "b" }]],
    [[{ name: "a" }], [{ other: "b" }]],
    [[{ other: "a" }], [{ name: "b" }]],
  ])("replaces nonidentity arrays %j with %j", (left, right) => {
    expect(mergeValues(Schema.Unknown, left, right)).toEqual(right);
  });

  test.each([...identities])("merges $field by its declared identity", ({ key, field }) => {
    expect(
      mergeValues(ServiceConfig, [{ [key]: "a", x: 1 }], [{ [key]: "a", y: 2 }, { [key]: "b" }], [field]),
    ).toEqual([{ [key]: "a", x: 1, y: 2 }, { [key]: "b" }]);
  });

  test("does not infer identities from properties of opaque entries", () => {
    expect(resolveLayerMergeRule(Schema.Unknown).key({ name: "a", id: "b" })).toBeUndefined();
    expect(mergeValues(Schema.Unknown, [{ name: "a", id: "b" }], [{ id: "b", x: 1 }])).toEqual([
      { id: "b", x: 1 },
    ]);
  });

  test("replaces filters lacking identity", () => {
    expect(mergeValues(RouteObjectInput, [{ kind: "redirect" }], [{}], ["filters"])).toEqual([{}]);
  });

  test.each([
    {
      name: "named scalar over object",
      left: [{ name: "ui", kind: "internal", protocol: "http", port: 80, primary: true }],
      right: ["ui=https:443"],
      expected: ["ui=https:443"],
    },
    {
      name: "named object over scalar",
      left: ["ui=http:80"],
      right: [{ name: "ui", kind: "internal", protocol: "https", port: 443, primary: true }],
      expected: [{ name: "ui", kind: "internal", protocol: "https", port: 443, primary: true }],
    },
    {
      name: "named scalar over scalar keeps siblings",
      left: ["ui=http:80", "other=tcp:9"],
      right: ["ui=https:443"],
      expected: ["ui=https:443", "other=tcp:9"],
    },
    {
      name: "object deep-merge keeps unmatched properties",
      left: [{ name: "ui", kind: "internal", protocol: "http", port: 80, appProtocol: "keep" }],
      right: [{ name: "ui", protocol: "https", port: 443 }],
      expected: [{ name: "ui", kind: "internal", protocol: "https", port: 443, appProtocol: "keep" }],
    },
    {
      name: "case-sensitive aliases stay distinct",
      left: ["UI=http:80"],
      right: ["ui=https:443"],
      expected: ["UI=http:80", "ui=https:443"],
    },
    {
      name: "duplicate lower names replace",
      left: ["ui=http:80", "ui=tcp:9"],
      right: ["ui=https:443"],
      expected: ["ui=https:443"],
    },
    {
      name: "uses the literal alias before evaluating the port",
      left: ["ui=http:80", "metrics=tcp:9000"],
      right: ["ui=http:{{ env.PORT }}"],
      expected: ["ui=http:{{ env.PORT }}", "metrics=tcp:9000"],
    },
    {
      name: "treats an expression in the alias as unkeyable",
      left: ["ui=http:80", "metrics=tcp:9000"],
      right: ["{{ env.N }}=http:8080"],
      expected: ["{{ env.N }}=http:8080"],
    },
    {
      name: "replaces a matching object when its kind changes",
      left: [
        { kind: "internal", name: "ui", protocol: "unix", socketPath: "/run/ui.sock" },
        "metrics=tcp:9000",
      ],
      right: [{ kind: "published", name: "ui", protocol: "http", port: 80, publication: {} }],
      expected: [
        { kind: "published", name: "ui", protocol: "http", port: 80, publication: {} },
        "metrics=tcp:9000",
      ],
    },
    {
      name: "merges matching objects of the same kind",
      left: [{ kind: "published", name: "ui", protocol: "http", port: 80, publication: { hostPort: 8080 } }],
      right: [{ kind: "published", name: "ui", port: 8081, publication: { bindAddress: "127.0.0.1" } }],
      expected: [
        {
          kind: "published",
          name: "ui",
          protocol: "http",
          port: 8081,
          publication: { hostPort: 8080, bindAddress: "127.0.0.1" },
        },
      ],
    },
    {
      name: "duplicate higher names replace",
      left: ["ui=http:80", "other=tcp:9"],
      right: ["ui=https:443", "ui=udp:53"],
      expected: ["ui=https:443", "ui=udp:53"],
    },
    {
      name: "unnamed list replaces",
      left: ["http:80", "tcp:9"],
      right: ["https:443"],
      expected: ["https:443"],
    },
    {
      name: "empty array clears",
      left: ["ui=http:80"],
      right: [],
      expected: [],
    },
  ] as const)("merges endpoints $name", ({ left, right, expected }) => {
    expect(mergeValues(ServiceConfig, left, right, ["endpoints"])).toEqual([...expected]);
  });

  test("three-layer endpoint replacement does not leak lower properties", () => {
    const layers = [
      ["base=http:80"],
      [{ name: "base", kind: "internal", protocol: "https", port: 443, primary: true }],
      ["base=tcp:9000"],
    ] as const;
    const merged = layers.reduce<unknown>(
      (left, right) => mergeValues(ServiceConfig, left, right, ["endpoints"]),
      [],
    );
    expect(merged).toEqual(["base=tcp:9000"]);
  });
});

const BRAND = Symbol.for("@lando/sdk/landofile/merge-directive");
const markerPaths = (value: unknown, path = "$"): ReadonlyArray<string> => {
  if (Array.isArray(value)) return value.flatMap((entry, index) => markerPaths(entry, `${path}[${index}]`));
  if (typeof value !== "object" || value === null) return [];
  return [
    ...(Object.getOwnPropertySymbols(value).includes(BRAND) ? [path] : []),
    ...Object.entries(value).flatMap(([key, entry]) => markerPaths(entry, `${path}.${key}`)),
  ];
};
const web = (value: Record<string, unknown>) => ({ services: { web: value } });

describe("native merge directives", () => {
  test.each([
    ["a map", "environment", { A: "a", B: "b" }, { C: "c" }],
    ["a keyed list", "routes", ["a.test", "b.test"], ["b.test"]],
    ["a scalar", "image", "nginx", "nginx:stable"],
  ] as const)("override replaces %s without merging", (_label, key, base, replacement) => {
    // Given an inherited value and an override at the same member; when folded.
    const result = mergeLandofiles([web({ [key]: base }), web({ [key]: override(replacement) })]);
    // Then the inherited value is fully replaced.
    expect(result).toEqual(web({ [key]: replacement }));
  });

  test("reset removes an existing member and ignores an absent one", () => {
    // Given one inherited key and one never-authored key, both reset.
    const result = mergeLandofiles([
      web({ environment: { OLD: "old", KEEP: "keep" } }),
      web({ environment: { OLD: reset(), ABSENT: reset() } }),
    ]);
    // Then only the existing key disappears and the containing map stays.
    expect(result).toEqual(web({ environment: { KEEP: "keep" } }));
  });

  test("reset removes a whole service without pruning the services map", () => {
    // Given a lower service and a higher reset of it; when folded.
    const result = mergeLandofiles([web({ image: "nginx" }), { services: { web: reset() } }]);
    // Then the member is absent, not null or empty.
    expect(result).toEqual({ services: {} });
  });

  test("a later ordinary value reintroduces a reset key", () => {
    // Given add, reset, then re-add across three layers; when folded.
    const result = mergeLandofiles([
      web({ environment: { FOO: "one" } }),
      web({ environment: { FOO: reset() } }),
      web({ environment: { FOO: "two" } }),
    ]);
    // Then the newest ordinary value wins.
    expect(result).toEqual(web({ environment: { FOO: "two" } }));
  });

  test("lowest-layer directives insert override payloads and drop resets", () => {
    // Given directives with nothing beneath them; when folded alone.
    const result = mergeLandofiles([web({ image: override("nginx"), environment: { GONE: reset() } })]);
    // Then the override inserts its payload and the reset removes nothing.
    expect(result).toEqual(web({ image: "nginx", environment: {} }));
  });

  test("consumes directives inside override payloads against an empty context", () => {
    // Given nested directives inside a replacement payload.
    const result = mergeLandofiles([
      web({ environment: { OLD: "old" } }),
      web({ environment: override({ OLD: reset(), NEW: override("new") }) }),
    ]);
    // Then the nested reset finds nothing and the nested override is unwrapped.
    expect(result).toEqual(web({ environment: { NEW: "new" } }));
  });

  test("materializes directives in new members, appended entries, and kind-change replacements", () => {
    // Given directives inside subtrees that bypass the recursive member merge.
    const result = mergeLandofiles([
      web({
        routes: [{ hostname: "a.test", filters: [{ name: "f", kind: "stripPrefix", prefix: "/a" }] }],
      }),
      {
        services: {
          web: {
            routes: [
              {
                hostname: "a.test",
                filters: [{ name: "f", kind: "redirect", to: override("/b"), x: reset() }],
              },
              { hostname: "b.test", filters: override([]), extra: reset() },
            ],
          },
          cache: { image: override("redis"), environment: { GONE: reset() } },
        },
      },
    ]);
    // Then every result is an effective value with no directive markers.
    expect(markerPaths(result)).toEqual([]);
    expect(result).toEqual({
      services: {
        web: {
          routes: [
            { hostname: "a.test", filters: [{ name: "f", kind: "redirect", to: "/b" }] },
            { hostname: "b.test", filters: [] },
          ],
        },
        cache: { image: "redis", environment: {} },
      },
    });
  });

  test("an empty collection still blanks an inherited keyed list", () => {
    // Given an inherited route list and an ordinary empty list; when folded.
    const result = mergeLandofiles([web({ routes: ["a.test"] }), web({ routes: [] })]);
    // Then routes are blanked, not removed.
    expect(result).toEqual(web({ routes: [] }));
  });

  test("mergeValues normalizes its left input and never returns markers", () => {
    // Given directives on both sides of an opaque merge.
    const result = mergeValues(
      Schema.Unknown,
      { a: reset(), b: override({ c: reset(), d: 1 }) },
      { e: override(2) },
    );
    // Then the result is marker-free and a top-level reset becomes undefined.
    expect(result).toEqual({ b: { d: 1 }, e: 2 });
    expect(markerPaths(result)).toEqual([]);
    expect(mergeValues(Schema.Unknown, { a: 1 }, reset())).toBeUndefined();
  });
});
