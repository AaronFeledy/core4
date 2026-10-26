import { describe, expect, test } from "bun:test";

import {
  composeServiceDispositions,
  composeTagDispositions,
  composeTopLevelDispositions,
} from "@lando/sdk/landofile";
import { ComposePreservedPathKey } from "@lando/sdk/schema";

describe("Compose disposition matrix", () => {
  test("gives every normalized service path a plan target within its root's targets", () => {
    // Given
    const normalizedEntries = Object.entries(composeServiceDispositions).filter(
      ([, entry]) => entry.disposition === "normalized",
    );

    // When / Then
    expect(normalizedEntries.length).toBeGreaterThan(0);
    for (const [path, entry] of normalizedEntries) {
      const root = path.split(".", 1)[0] ?? path;
      const rootTargets = composeServiceDispositions[root]?.planTarget;
      expect(entry.planTarget).toBeDefined();
      expect(entry.planTarget?.length).toBeGreaterThan(0);
      for (const target of entry.planTarget ?? []) {
        expect(rootTargets, `${path} must normalize within its root's plan targets`).toContain(target);
      }
    }
    expect(composeServiceDispositions["build.args"]?.planTarget).toEqual(["artifact"]);
    expect(composeServiceDispositions["depends_on.*.condition"]?.planTarget).toEqual(["dependsOn"]);
    expect(composeServiceDispositions["volumes.target"]?.planTarget).toEqual(["mounts"]);
    expect(composeServiceDispositions.tmpfs?.planTarget).toEqual(["mounts"]);
  });

  test("documents service-level x-* as inert rather than capability-gated", () => {
    // Given
    const serviceExtension = composeServiceDispositions["x-*"];
    const gatedExtension = composeServiceDispositions["configs.x-*"];

    // When / Then
    expect(serviceExtension?.disposition).toBe("preserved");
    expect(serviceExtension?.rationale).not.toContain("capability-checked");
    expect(serviceExtension?.rationale).toContain("inert");
    expect(gatedExtension?.rationale).toContain("capability-checked");
  });

  test("documents every exact preserved path with its fail-closed capability gate", () => {
    for (const path of ComposePreservedPathKey.literals) {
      const entry = composeServiceDispositions[path];
      expect(entry?.disposition).toBe("preserved");
      expect(entry?.rationale).toContain("composePreservedPaths");
      expect(entry?.rationale).toContain("CapabilityError");
    }
  });

  test("normalizes every volume form into the one service mount list", () => {
    // Given
    const typed = [
      "volumes.bind",
      "volumes.bind.create_host_path",
      "volumes.volume",
      "volumes.volume.subpath",
      "volumes.tmpfs",
      "volumes.tmpfs.mode",
      "volumes.tmpfs.size",
    ] as const;

    // When / Then
    for (const path of typed) {
      expect(composeServiceDispositions[path]?.disposition, path).toBe("normalized");
      expect(composeServiceDispositions[path]?.planTarget, path).toEqual(["mounts"]);
    }
    expect(composeServiceDispositions["volumes.read_only"]?.planTarget).toEqual(["mounts"]);
  });

  test("normalizes Compose layer override tags through native layer merging", () => {
    expect(Object.keys(composeTagDispositions).sort()).toEqual(["!override", "!reset"]);

    for (const entry of Object.values(composeTagDispositions)) {
      expect(entry.disposition).toBe("normalized");
      expect(entry.rationale.length).toBeGreaterThan(0);
      expect(entry.remediation).toBeUndefined();
    }
  });

  test("keeps YAML tags isolated from schema-key disposition matrices", () => {
    expect(Object.keys(composeServiceDispositions).some((path) => path.startsWith("!"))).toBe(false);
    expect(Object.keys(composeTopLevelDispositions).some((path) => path.startsWith("!"))).toBe(false);
  });
});
