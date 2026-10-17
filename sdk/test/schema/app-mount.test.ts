import { expect, test } from "bun:test";
import { Schema, SchemaIssue } from "effect";

import {
  AppMountPlan,
  DataStoreMountPlan,
  LandofileAuthoringShape,
  MountPlan,
  ServiceConfig,
  appMountSyncIgnores,
} from "@lando/sdk/schema";

const appMount = (excludes: readonly string[] = [], includes: readonly string[] = []) =>
  Schema.decodeUnknownSync(AppMountPlan)({
    source: "/repo",
    target: "/app",
    readOnly: false,
    realization: "accelerated",
    excludes,
    includes,
  });

test("cancels exact excludes when includes names the whole entry", () => {
  // Given overlapping excludes and an exact include.
  const service = {
    appMount: appMount(["vendor", "vendor/", "node_modules", "vendor"], ["vendor"]),
    storage: [],
    mounts: [],
  };
  // When deriving sync ignores.
  const ignores = appMountSyncIgnores(service);
  // Then only the exact entry is removed, with stable order and deduplication.
  expect(ignores).toEqual(["vendor/", "node_modules", ".git"]);
});

test("derives relative ignores from storage and non-bind mounts under the app target", () => {
  // Given overlapping shadows, authored storage, cache storage, and generic mounts.
  const storage = Schema.decodeUnknownSync(Schema.Array(DataStoreMountPlan))([
    { store: "shadow", target: "/app/node_modules", readOnly: false },
    { store: "uploads", target: "/app/public/uploads", readOnly: false },
    { store: "cache", target: "/app/.cache", readOnly: false },
    { store: "outside", target: "/application/data", readOnly: false },
    { store: "root", target: "/app", readOnly: false },
  ]);
  const mounts = Schema.decodeUnknownSync(Schema.Array(MountPlan))([
    { type: "tmpfs", target: "/app/tmp", readOnly: false, realization: "passthrough" },
    { type: "volume", target: "/app/vendor", readOnly: false, realization: "passthrough" },
    { type: "bind", source: "/host", target: "/app/config", readOnly: false, realization: "passthrough" },
  ]);
  // When deriving sync ignores from the finalized service.
  const ignores = appMountSyncIgnores({
    appMount: appMount(["node_modules", "tmp"]),
    storage: ["/app/logs", ...storage, "/outside"],
    mounts,
  });
  // Then excludes precede new overlay paths and Git comes last; binds and outside paths stay visible.
  expect(ignores).toEqual(["node_modules", "tmp", "logs", "public/uploads", ".cache", "vendor", ".git"]);
});

test("matches exclude policy when a storage-only overlay owns the same subtree", () => {
  // Given equivalent ownership expressed as an exclude or storage shorthand.
  const excluded = { appMount: appMount(["node_modules"]), storage: [], mounts: [] };
  const stored = { appMount: appMount(), storage: ["/app/node_modules"], mounts: [] };
  // When deriving both lists.
  const ignores = appMountSyncIgnores(stored);
  // Then both produce the same sync behavior.
  expect(ignores).toEqual(appMountSyncIgnores(excluded));
});

test.each([false, true])("syncs Git only when explicitly included (%s)", (included) => {
  // Given a fixed Git rule and optional include.
  const service = { appMount: appMount([], included ? [".git"] : []), storage: [], mounts: [] };
  // When deriving sync ignores.
  const ignores = appMountSyncIgnores(service);
  // Then includes alone cancels the fixed ignore.
  expect(ignores).toEqual(included ? [] : [".git"]);
});

test("has no app ignores when the service has no app mount", () => {
  // Given storage without an app mount.
  const service = { storage: ["/app/node_modules"], mounts: [] };
  // When deriving sync ignores.
  const ignores = appMountSyncIgnores(service);
  // Then no app synchronization policy is created.
  expect(ignores).toEqual([]);
});

test.each(["excludes", "includes"] as const)("rejects negated %s at the entry path", (field) => {
  // Given a negated entry at the authoring boundary.
  const input = {
    runtime: 4,
    name: "demo",
    services: { web: { appMount: { target: "/app", [field]: ["!vendor"] } } },
  };
  // When decoding literal authoring input.
  const result = Schema.decodeUnknownResult(LandofileAuthoringShape)(input);
  // Then lint can report the precise entry and actionable includes guidance.
  expect(result._tag).toBe("Failure");
  if (result._tag !== "Failure") throw new Error("Expected invalid app-mount entry");
  const issues = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues;
  expect(issues).toContainEqual({
    path: ["services", "web", "appMount", field, 0],
    message: "Use includes: [vendor] to keep vendor; `!` entries are not supported.",
  });
});

test("preserves plain policy across strict repeated decoding", () => {
  // Given authored exclude and include policy.
  const input = { appMount: { target: "/app", excludes: ["vendor"], includes: [".git"] } };
  const decode = Schema.decodeUnknownSync(ServiceConfig, { onExcessProperty: "error" });
  // When the layered pipeline decodes twice.
  const config = decode(decode(input));
  // Then the canonical policy remains intact.
  expect(config.appMount).toEqual(input.appMount);
});
