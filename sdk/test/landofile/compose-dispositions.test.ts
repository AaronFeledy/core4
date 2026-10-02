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
    expect(composeServiceDispositions["volumes.target"]?.planTarget).toEqual([
      "mounts",
      "storage",
      "extensions.compose.tmpfs",
    ]);
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

  test("narrows type-specific volume options to the destination they actually reach", () => {
    // Given
    const bindOnly = ["volumes.bind", "volumes.bind.create_host_path"] as const;
    const storageOnly = ["volumes.volume", "volumes.volume.subpath"] as const;

    // When / Then
    for (const path of bindOnly) {
      expect(composeServiceDispositions[path]?.planTarget, path).toEqual(["mounts"]);
    }
    for (const path of storageOnly) {
      expect(composeServiceDispositions[path]?.planTarget, path).toEqual(["storage"]);
    }
    expect(composeServiceDispositions["volumes.read_only"]?.planTarget).toEqual([
      "mounts",
      "storage",
      "extensions.compose.tmpfs",
    ]);
  });

  test("rejects Compose layer override tags with merge remediation", () => {
    expect(Object.keys(composeTagDispositions).sort()).toEqual(["!override", "!reset"]);

    for (const entry of Object.values(composeTagDispositions)) {
      expect(entry.disposition).toBe("rejected");
      expect(entry.rationale.length).toBeGreaterThan(0);
      expect(entry.remediation?.length).toBeGreaterThan(0);
      expect(entry.remediation).toContain("merge");
    }
  });

  test("keeps YAML tags isolated from schema-key disposition matrices", () => {
    expect(Object.keys(composeServiceDispositions).some((path) => path.startsWith("!"))).toBe(false);
    expect(Object.keys(composeTopLevelDispositions).some((path) => path.startsWith("!"))).toBe(false);
  });
});
