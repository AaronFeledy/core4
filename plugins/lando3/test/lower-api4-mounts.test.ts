import { describe, expect, test } from "bun:test";
import { LEGACY_TAGGED } from "@lando/sdk/landofile";
import { lowerApi4Mounts } from "../src/lower-api4-mounts.ts";
import type { ServiceLoweringContext } from "../src/lowering-contract.ts";

const ctx: ServiceLoweringContext = {
  serviceFacts: {},
  serviceName: "web",
  keyPath: ["services", "web"],
  fallbackSourceId: ".lando.yml",
  occurrenceAt: () => undefined,
  topLevel: { excludes: [], includes: [] },
};
const path = (...relative: readonly (string | number)[]) => ["services", "web", ...relative];

describe("API-4 mount normalization", () => {
  test.each([false, 0, "0", "FALSE", "Off", "disable", "DISABLED", null])(
    "disables authored app-mount %j",
    (value) => {
      // Given / When
      const result = lowerApi4Mounts({ "app-mount": value }, ctx);
      // Then
      expect(result.patch.appMount).toBe(false);
      expect(result.diagnostics).toEqual([]);
    },
  );
  test.each([true, 8])("diagnoses invalid app-mount %j without emitting it", (value) => {
    // Given / When
    const result = lowerApi4Mounts({ appMount: value }, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toMatchObject([{ kind: "unsupported", keyPath: path("appMount") }]);
  });
  test.each([
    [{ appMount: "/a", appmount: "/b", "app-mount": "/c" }, "/a", ["appmount", "app-mount"]],
    [{ appMount: null, appmount: "/b", "app-mount": "/c" }, "/b", ["appMount", "app-mount"]],
    [{ appMount: null, appmount: null, "app-mount": "/c" }, "/c", ["appMount", "appmount"]],
  ] as const)("honors app alias precedence for %j", (service, target, ignored) => {
    // Given / When
    const result = lowerApi4Mounts(service, ctx);
    // Then
    expect(result.patch.appMount).toEqual({ target });
    expect(result.diagnostics.map((diagnostic) => diagnostic.keyPath)).toEqual(
      ignored.map((key) => path(key)),
    );
  });
  test.each([
    [{}, []],
    [{ appMount: null, appmount: null }, ["appMount", "appmount"]],
  ] as const)("leaves %j at the v4 app-mount default", (service, ignored) => {
    // Given / When
    const result = lowerApi4Mounts(service, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toMatchObject(ignored.map((key) => ({ kind: "dropped", keyPath: path(key) })));
  });
  test.each([
    ["/site", { target: "/site" }, []],
    ["/site:rw", { target: "/site" }, []],
    ["/site:ro", { target: "/site", readOnly: true }, []],
    ["/site:cached", { target: "/site" }, ["rewritten"]],
  ] as const)("parses app short form %s", (value, expected, kinds) => {
    // Given / When
    const result = lowerApi4Mounts({ "app-mount": value }, ctx);
    // Then
    expect(result.patch.appMount).toEqual(expected);
    expect(result.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([...kinds]);
  });
  test("drops forced app sources and ownership while retaining the dest alias", () => {
    // Given / When
    const result = lowerApi4Mounts(
      { "app-mount": { source: "./src", src: "./other", dest: "/site", owner: "www-data" } },
      ctx,
    );
    // Then
    expect(result.patch.appMount).toEqual({ target: "/site" });
    expect(result.diagnostics.map((diagnostic) => diagnostic.keyPath)).toEqual([
      path("app-mount", "source"),
      path("app-mount", "src"),
      path("app-mount", "owner"),
    ]);
    expect(result.diagnostics[0]?.message).toContain("Lando 3 always mounted the app root");
    expect(result.diagnostics[0]?.remediation).toContain("mounts:");
  });
  test("concatenates mounts and mount in authored collection order", () => {
    // Given / When
    const result = lowerApi4Mounts({ mounts: [{ src: "./a", dest: "/b" }], mount: ["./c:/d"] }, ctx);
    // Then
    expect(result.patch.mounts).toEqual([
      { source: "./a", target: "/b" },
      { source: "./c", target: "/d" },
    ]);
    expect(result.diagnostics).toEqual([]);
  });
  test("accounts for losing target and source aliases exactly once", () => {
    // Given / When
    const result = lowerApi4Mounts(
      {
        mounts: [
          { source: "./a", src: "./ignored", target: "/b", destination: "/ignored", dest: "/also-ignored" },
        ],
      },
      ctx,
    );
    // Then
    expect(result.patch.mounts).toEqual([{ source: "./a", target: "/b" }]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.keyPath)).toEqual([
      path("mounts", 0, "destination"),
      path("mounts", 0, "dest"),
      path("mounts", 0, "src"),
    ]);
  });
  test.each([
    ["./a:/b", { source: "./a", target: "/b" }, []],
    ["./a:/b:rw", { source: "./a", target: "/b" }, []],
    ["./a:/b:ro", { source: "./a", target: "/b", readOnly: true }, []],
    ["./a:/b:cached", { source: "./a", target: "/b" }, ["rewritten"]],
  ] as const)("parses bind short form %s", (value, expected, kinds) => {
    // Given / When
    const result = lowerApi4Mounts({ mounts: [value] }, ctx);
    // Then
    expect(result.patch.mounts).toEqual([expected]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([...kinds]);
  });
  test.each(["./a", "a:b:c:d"])("drops malformed short form %s", (value) => {
    // Given / When
    const result = lowerApi4Mounts({ mount: [value] }, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toMatchObject([{ kind: "dropped", keyPath: path("mount", 0) }]);
  });
  test.each([true, false])("maps Compose read_only %s and drops readOnly", (value) => {
    // Given / When
    const result = lowerApi4Mounts(
      { mounts: [{ source: ".", target: "/app", read_only: value, readOnly: !value }] },
      ctx,
    );
    // Then
    expect(result.patch.mounts).toEqual([{ source: ".", target: "/app", readOnly: value }]);
    expect(result.diagnostics).toMatchObject([{ kind: "dropped", keyPath: path("mounts", 0, "readOnly") }]);
  });
  test.each([".", "./", ""])("merges exclude spellings and negation for app-root source %j", (source) => {
    // Given / When
    const result = lowerApi4Mounts(
      { mounts: [{ source, target: "/app", exclude: "/cache", excludes: ["!cache/keep", "!/cache/live"] }] },
      ctx,
    );
    // Then
    expect(result.patch.mounts).toEqual([
      { source, target: "/app", excludes: ["cache"], includes: ["cache/keep", "cache/live"] },
    ]);
  });
  test.each([{ source: "./other" }, { source: ".", read_only: true }])(
    "rebinds include paths from the app root for %j",
    (options) => {
      // Given / When
      const result = lowerApi4Mounts(
        { mounts: [{ ...options, target: "/app", excludes: ["!/cache/keep"] }] },
        ctx,
      );
      // Then
      expect(result.patch.mounts).toEqual([
        { source: options.source, target: "/app", ...("read_only" in options ? { readOnly: true } : {}) },
        { source: "./cache/keep", target: "/app/cache/keep" },
      ]);
      expect(result.diagnostics).toMatchObject([{ kind: "rewritten", keyPath: path("mounts", 0) }]);
    },
  );
  test("drops bind includes that Lando 3 never applied", () => {
    // Given / When
    const result = lowerApi4Mounts(
      { mounts: [{ source: ".", target: "/app", include: "a", includes: ["b"] }] },
      ctx,
    );
    // Then
    expect(result.patch.mounts).toEqual([{ source: ".", target: "/app" }]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.keyPath)).toEqual([
      path("mounts", 0, "include"),
      path("mounts", 0, "includes"),
    ]);
  });
  test("keeps copy includes live on the converted app-root bind", () => {
    // Given / When
    const result = lowerApi4Mounts(
      { mounts: [{ type: "copy", source: ".", target: "/app", include: "a", includes: ["b"] }] },
      ctx,
    );
    // Then
    expect(result.patch.mounts).toEqual([{ source: ".", target: "/app", includes: ["a", "b"] }]);
    expect(result.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual(["needs-review", "needs-review"]);
  });
  test.each([
    "owner",
    "permissions",
    "perms",
    "user",
    "group",
    "scope",
    "instructions",
    "bind",
    "consistency",
    "x-custom",
    "content",
    "contents",
  ])("accounts for retained bind field %s", (key) => {
    // Given / When
    const result = lowerApi4Mounts({ mounts: [{ source: "./a", target: "/b", [key]: "value" }] }, ctx);
    // Then
    expect(result.patch.mounts).toEqual([{ source: "./a", target: "/b" }]);
    expect(result.diagnostics).toMatchObject([{ kind: "dropped", keyPath: path("mounts", 0, key) }]);
  });
  test.each(["storage", "storage:volume"])("routes %s before bind source validation", (type) => {
    // Given / When
    const result = lowerApi4Mounts({ mounts: [{ type, dest: "/data", scope: "project" }] }, ctx);
    // Then
    expect(result.patch.storage).toEqual([{ store: "app-data", target: "/data", scope: "app" }]);
    expect(result.diagnostics).toMatchObject([{ kind: "rewritten", keyPath: path("mounts", 0, "scope") }]);
  });
  test("routes storage:bind into binds", () => {
    // Given / When
    const result = lowerApi4Mounts({ mounts: [{ type: "storage:bind", src: "./a", dest: "/b" }] }, ctx);
    // Then
    expect(result.patch.mounts).toEqual([{ source: "./a", target: "/b" }]);
  });
  test.each(["tmpfs", "storage:image"])("drops ignored mount type %s as a whole entry", (type) => {
    // Given / When
    const result = lowerApi4Mounts({ mounts: [{ type, target: "/data", scope: "app" }] }, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toMatchObject([{ kind: "dropped", keyPath: path("mounts", 0) }]);
  });
  test("drops unknown storage scope while retaining default service storage", () => {
    // Given / When
    const result = lowerApi4Mounts({ storage: [{ dest: "/data", scope: "other" }] }, ctx);
    // Then
    expect(result.patch.storage).toEqual([{ store: "app-web-data", target: "/data" }]);
    expect(result.diagnostics).toMatchObject([{ kind: "dropped", keyPath: path("storage", 0, "scope") }]);
  });
  test("rejects global data storage rather than emitting a planning failure", () => {
    // Given / When
    const result = lowerApi4Mounts({ storage: [{ target: "/data", scope: "global" }] }, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toMatchObject([
      {
        kind: "unsupported",
        keyPath: path("storage", 0, "scope"),
        remediation: expect.stringContaining("scope: app"),
      },
    ]);
  });
  test.each([
    [{ mounts: [{ source: "./a" }] }, "dropped", ["mounts", 0]],
    [{ mounts: [{ target: "/b" }] }, "dropped", ["mounts", 0]],
    [{ storage: [{}] }, "dropped", ["storage", 0]],
    [{ "app-mount": { source: "./a" } }, "unsupported", ["app-mount"]],
  ] as const)("diagnoses missing required paths in %j", (service, kind, relative) => {
    // Given / When
    const result = lowerApi4Mounts(service, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.diagnostics).toMatchObject([{ kind, keyPath: path(...relative) }]);
  });
  test.each(["source", "target"])("blocks tagged %s without reading it", (key) => {
    // Given
    const tagged = { [LEGACY_TAGGED]: true, tag: "!load", value: "./absent" };
    // When
    const result = lowerApi4Mounts({ mounts: [{ source: "./a", target: "/b", [key]: tagged }] }, ctx);
    // Then
    expect(result.patch).toEqual({});
    expect(result.blocked).toBe(true);
    expect(result.diagnostics).toMatchObject([{ kind: "unsupported", keyPath: path("mounts", 0, key) }]);
  });
});
