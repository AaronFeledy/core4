import { describe, expect, test } from "bun:test";

import { planUpdates } from "../../src/update/plugin-plan.ts";

describe("planUpdates", () => {
  test("orders core first and plugins by name while preserving selector intent", () => {
    const plan = planUpdates({
      currentCoreVersion: "4.1.0",
      targetCoreVersion: "4.2.0",
      selection: "all",
      plugins: [
        {
          name: "z-plugin",
          currentVersion: "1.0.0",
          currentRequires: { "@lando/core": "^4.0.0" },
          requestedSelector: "next",
          trusted: true,
          metadata: {
            distTags: { next: "1.1.0" },
            versions: {
              "1.1.0": {
                name: "z-plugin",
                version: "1.1.0",
                requires: { "@lando/core": "^4.0.0" },
              },
            },
          },
        },
        {
          name: "a-plugin",
          currentVersion: "2.0.0",
          currentRequires: { "@lando/core": "^4.0.0" },
          requestedSelector: "2.0.0",
          trusted: true,
          metadata: { distTags: { latest: "2.1.0" }, versions: {} },
        },
      ],
    });

    expect(plan.rows.map((row) => (row.kind === "core" ? "core" : row.name))).toEqual([
      "core",
      "a-plugin",
      "z-plugin",
    ]);
    expect(plan.rows[1]).toMatchObject({ status: "unchanged", selector: "2.0.0" });
    expect(plan.rows[2]).toMatchObject({ status: "update", selector: "next", targetVersion: "1.1.0" });
  });

  test("holds unsafe inventory and blocks a combined core update when the resulting set is incompatible", () => {
    const plan = planUpdates({
      currentCoreVersion: "4.1.0",
      targetCoreVersion: "5.0.0",
      selection: "all",
      plugins: [
        {
          name: "legacy",
          currentVersion: "1.0.0",
          currentRequires: { "@lando/core": "^4.0.0" },
          trusted: true,
        },
        {
          name: "linked",
          currentVersion: "1.0.0",
          currentRequires: { "@lando/core": "^4.0.0" },
          source: "linked",
          trusted: true,
        },
        {
          name: "untrusted",
          currentVersion: "1.0.0",
          currentRequires: { "@lando/core": ">=4 <6" },
          requestedSelector: "latest",
          trusted: false,
        },
        {
          name: "untrusted-pinned",
          currentVersion: "1.0.0",
          currentRequires: { "@lando/core": ">=4 <6" },
          requestedSelector: "1.0.0",
          trusted: false,
        },
      ],
    });

    expect(plan.rows[0]).toMatchObject({ kind: "core", status: "blocked", reason: "plugin-compatibility" });
    expect(plan.rows.slice(1)).toMatchObject([
      { name: "legacy", status: "held", reason: "selector-unknown" },
      { name: "linked", status: "held", reason: "linked" },
      { name: "untrusted", status: "held", reason: "trust-required" },
      { name: "untrusted-pinned", status: "held", reason: "trust-required" },
    ]);
    expect(plan.hasFailures).toBe(true);
  });

  test("rejects metadata identity mismatches, downgrades, major upgrades, and incompatible candidates", () => {
    const makePlugin = (
      name: string,
      target: string,
      advertised: { readonly name: string; readonly version: string; readonly range: string },
    ) => ({
      name,
      currentVersion: "1.2.0",
      currentRequires: { "@lando/core": "^4.0.0" },
      requestedSelector: "latest",
      trusted: true,
      metadata: {
        distTags: { latest: target },
        versions: {
          [target]: {
            name: advertised.name,
            version: advertised.version,
            requires: { "@lando/core": advertised.range },
          },
        },
      },
    });
    const plan = planUpdates({
      currentCoreVersion: "4.1.0",
      targetCoreVersion: "4.2.0",
      selection: "plugins",
      plugins: [
        makePlugin("bad-name", "1.3.0", { name: "other", version: "1.3.0", range: "^4.0.0" }),
        makePlugin("downgrade", "1.1.0", { name: "downgrade", version: "1.1.0", range: "^4.0.0" }),
        makePlugin("major", "2.0.0", { name: "major", version: "2.0.0", range: "^4.0.0" }),
        makePlugin("target-only", "1.3.0", { name: "target-only", version: "1.3.0", range: ">=4.2" }),
      ],
    });

    expect(plan.rows).toMatchObject([
      { name: "bad-name", status: "failed", reason: "metadata-mismatch" },
      { name: "downgrade", status: "failed", reason: "downgrade" },
      { name: "major", status: "failed", reason: "major-change" },
      { name: "target-only", status: "held", reason: "current-core-incompatible" },
    ]);
    expect(plan.hasFailures).toBe(true);
  });
});
