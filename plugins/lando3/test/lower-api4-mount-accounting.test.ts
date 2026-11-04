import { expect, test } from "bun:test";
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

test("preserves top-level masks while rebinding includes beneath a read-only app mount", () => {
  // Given
  const context = { ...ctx, topLevel: { excludes: ["/cache", "!/cache/keep"], includes: ["live"] } };
  // When
  const result = lowerApi4Mounts(
    { "app-mount": { target: "/site", read_only: true, exclude: "deps" } },
    context,
  );
  // Then
  expect(result.patch).toEqual({
    appMount: { target: "/site", readOnly: true, excludes: ["cache", "deps"] },
    mounts: [
      { source: "./live", target: "/site/live" },
      { source: "./cache/keep", target: "/site/cache/keep" },
    ],
  });
  expect(result.diagnostics).toMatchObject([
    { kind: "rewritten", keyPath: ["services", "web", "app-mount"] },
  ]);
});

test("rebinds copy includes from the app root rather than the copy source", () => {
  // Given / When
  const result = lowerApi4Mounts(
    { mounts: [{ source: "./vendor", target: "/site", type: "copy", include: "a", includes: ["b"] }] },
    ctx,
  );
  // Then
  expect(result.patch.mounts).toEqual([
    { source: "./vendor", target: "/site" },
    { source: "./a", target: "/site/a" },
    { source: "./b", target: "/site/b" },
  ]);
  expect(result.diagnostics.map((entry) => entry.kind)).toEqual(["needs-review", "rewritten"]);
});

test("keeps each child rebind immediately after its parent", () => {
  // Given / When
  const result = lowerApi4Mounts(
    {
      mounts: [
        "./first:/first",
        { source: "./vendor", target: "/site", excludes: ["!live"] },
        "./last:/last",
      ],
    },
    ctx,
  );
  // Then
  expect(result.patch.mounts).toEqual([
    { source: "./first", target: "/first" },
    { source: "./vendor", target: "/site" },
    { source: "./live", target: "/site/live" },
    { source: "./last", target: "/last" },
  ]);
});

test("accounts for every storage field and losing alias on a retained volume", () => {
  // Given
  const item = {
    source: "existing",
    src: "ignored",
    target: "/data",
    destination: "/ignored",
    dest: "/also-ignored",
    type: "volume",
    scope: "service",
    owner: "www",
    perms: 775,
    instructions: "echo ignored",
  };
  // When
  const result = lowerApi4Mounts({ storage: [item] }, ctx);
  // Then
  expect(result.patch.storage).toEqual([{ store: "existing", target: "/data", scope: "service" }]);
  expect(result.diagnostics.map((entry) => entry.keyPath.at(-1))).toEqual([
    "destination",
    "dest",
    "src",
    "owner",
    "perms",
    "instructions",
  ]);
});

test("concatenates storage and persistent-storage while parsing bind modes", () => {
  // Given / When
  const result = lowerApi4Mounts(
    { storage: ["/data", "./host:/bound:cached"], "persistent-storage": ["/other", "./host:/read-only:ro"] },
    ctx,
  );
  // Then
  expect(result.patch.storage).toEqual([
    { store: "app-web-data", target: "/data" },
    { store: "app-web-other", target: "/other" },
  ]);
  expect(result.patch.mounts).toEqual([
    { source: "./host", target: "/bound" },
    { source: "./host", target: "/read-only", readOnly: true },
  ]);
  expect(result.diagnostics.map((entry) => entry.keyPath.slice(2))).toEqual([
    ["storage", 1],
    ["persistent-storage"],
  ]);
});

test("classifies ignored storage subtypes before inspecting tagged bind paths", () => {
  // Given
  const tagged = { [LEGACY_TAGGED]: true, tag: "!load", value: "./absent" };
  // When
  const result = lowerApi4Mounts({ mounts: [{ type: "storage:image", source: tagged }] }, ctx);
  // Then
  expect(result.blocked).toBeUndefined();
  expect(result.diagnostics).toMatchObject([{ kind: "dropped", keyPath: ["services", "web", "mounts", 0] }]);
});

test.each(["read_only", "exclude", "excludes", "include", "includes"])(
  "diagnoses malformed retained copy field %s once",
  (key) => {
    // Given / When
    const result = lowerApi4Mounts(
      { mounts: [{ source: ".", target: "/app", type: "copy", [key]: 42 }] },
      ctx,
    );
    // Then
    expect(result.patch.mounts).toEqual([{ source: ".", target: "/app" }]);
    expect(result.diagnostics.filter((entry) => entry.keyPath.at(-1) === key)).toMatchObject([
      { kind: "dropped", keyPath: ["services", "web", "mounts", 0, key] },
    ]);
  },
);
