import { expect, test } from "bun:test";
import { Schema } from "effect";

import { AppMountPlan, ServiceConfig, effectiveAppMountSyncExcludes } from "@lando/sdk/schema";

test("defaults decoded sync excludes to an empty array", () => {
  // Given an app mount without sync-only policy.
  const input = {
    source: "/repo",
    target: "/app",
    readOnly: false,
    excludes: [],
    includes: [],
    realization: "passthrough",
  };
  // When decoding the public plan contract.
  const plan = Schema.decodeUnknownSync(AppMountPlan)(input);
  // Then consumers always receive the required array.
  expect(plan.syncExcludes).toEqual([]);
});

test("derives ordered unique sync ignores with exact includes and retained negations", () => {
  // Given overlapping lists, an exact include, and a distinct trailing-slash pattern.
  const plan = Schema.decodeUnknownSync(AppMountPlan)({
    source: "/repo",
    target: "/app",
    readOnly: false,
    realization: "accelerated",
    excludes: ["vendor", "vendor/", "node_modules", "!keep"],
    syncExcludes: [".git", "vendor", "!keep", "logs"],
    includes: ["vendor", "logs"],
  });
  // When projecting the engine-facing list.
  const ignores = effectiveAppMountSyncExcludes(plan);
  // Then includes apply to both lists without rewriting negations or similar patterns.
  expect(ignores).toEqual(["vendor/", "node_modules", "!keep", ".git"]);
});

test("preserves authored sync excludes across strict repeated decoding", () => {
  // Given authored app-mount policy.
  const input = { appMount: { target: "/app", syncExcludes: [".git", "logs"] } };
  const decode = Schema.decodeUnknownSync(ServiceConfig, { onExcessProperty: "error" });
  // When the layered Landofile pipeline decodes it twice.
  const config = decode(decode(input));
  // Then sync-only entries survive without becoming overlay excludes.
  expect(config.appMount).toEqual(input.appMount);
});

test("rejects non-string authored sync excludes", () => {
  // Given an invalid sync-only pattern.
  const input = { appMount: { target: "/app", syncExcludes: [42] } };
  // When decoding the public authoring boundary.
  const decode = () => Schema.decodeUnknownSync(ServiceConfig)(input);
  // Then malformed patterns cannot reach planning.
  expect(decode).toThrow();
});
