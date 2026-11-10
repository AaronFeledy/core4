import { describe, expect, test } from "bun:test";

import {
  type ComposeDispositionEntry,
  composeDispositionFor,
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
    expect(composeServiceDispositions.hostname?.disposition).toBe("rejected");
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
    expect(gatedExtension?.disposition).toBe("normalized");
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

  test.each([
    ["mem_limit", "deploy.resources.limits.memory"],
    ["cpus", "deploy.resources.limits.cpus"],
    ["pids_limit", "deploy.resources.limits.pids"],
    ["mem_reservation", "deploy.resources.reservations.memory"],
  ])("rejects flat %s and points at its deploy counterpart %s", (path, counterpart) => {
    const entry = composeServiceDispositions[path];
    expect(entry?.disposition).toBe("rejected");
    expect(entry?.remediation).toBe(`Remove ${path} and set ${counterpart} instead.`);
    expect(composeServiceDispositions[counterpart]?.disposition).toBe("preserved");
  });

  test.each([
    ["deploy.resources.reservations.cpus", "deploy.resources.limits.cpus"],
    ["deploy.resources.reservations.generic_resources", "deploy.resources.reservations.devices"],
  ])("rejects Swarm-only %s at its root and names %s", (path, alternative) => {
    const entry = composeServiceDispositions[path];
    expect(entry?.disposition).toBe("rejected");
    expect(entry?.remediation).toContain(alternative);
    expect(Object.keys(composeServiceDispositions).filter((key) => key.startsWith(`${path}.`))).toEqual([]);
    expect(composeDispositionFor(composeServiceDispositions, `${path}.discrete_resource_spec`)).toBe(entry);
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

describe("composeDispositionFor", () => {
  const rejected = { disposition: "rejected", rationale: "r", remediation: "Remove it." } as const;
  const preserved = { disposition: "preserved", rationale: "p" } as const;
  const normalized = { disposition: "normalized", rationale: "n", planTarget: ["x"] } as const;
  const matrix: Readonly<Record<string, ComposeDispositionEntry>> = {
    hook: rejected,
    "hook.command": preserved,
    kept: preserved,
    mounts: normalized,
    "mounts.image": rejected,
    "nets.*": rejected,
    "x-*": preserved,
  };

  test("returns the exact entry for a matrix key", () => {
    expect(composeDispositionFor(matrix, "kept")).toBe(preserved);
    expect(composeDispositionFor(matrix, "hook.command")).toBe(preserved);
  });

  test("resolves a nested path to its nearest rejected ancestor", () => {
    expect(composeDispositionFor(matrix, "hook.environment.*")).toBe(matrix.hook);
    expect(composeDispositionFor(matrix, "mounts.image.subpath")).toBe(matrix["mounts.image"]);
  });

  test("leaves an unlisted path under an accepted key unresolved", () => {
    expect(composeDispositionFor(matrix, "kept.child")).toBeUndefined();
    expect(composeDispositionFor(matrix, "hook.command.child")).toBeUndefined();
    expect(composeDispositionFor(matrix, "mounts.source")).toBeUndefined();
    expect(composeDispositionFor(matrix, "mounts.source.image")).toBeUndefined();
  });

  test("leaves unknown roots and prototype names unresolved", () => {
    expect(composeDispositionFor(matrix, "unknown")).toBeUndefined();
    expect(composeDispositionFor(matrix, "constructor")).toBeUndefined();
    expect(composeDispositionFor(matrix, "__proto__")).toBeUndefined();
    expect(composeDispositionFor(matrix, "toString.x")).toBeUndefined();
  });

  test("treats wildcard and extension segments literally", () => {
    expect(composeDispositionFor(matrix, "nets.*.aliases")).toBe(matrix["nets.*"]);
    expect(composeDispositionFor(matrix, "nets.shared.aliases")).toBeUndefined();
    expect(composeDispositionFor(matrix, "hook.x-*")).toBe(matrix.hook);
    expect(composeDispositionFor(matrix, "x-custom")).toBeUndefined();
  });

  test("answers for nested paths that the service matrix does not list", () => {
    expect(composeServiceDispositions["pre_start.networks.*.aliases"]).toBeUndefined();
    expect(composeDispositionFor(composeServiceDispositions, "pre_start.networks.*.aliases")).toBe(
      composeServiceDispositions.pre_start,
    );
    expect(composeDispositionFor(composeServiceDispositions, "volumes.image.subpath")).toBe(
      composeServiceDispositions["volumes.image"],
    );
  });

  test("lists no service matrix key under a rejected ancestor", () => {
    // Given
    const keys = Object.keys(composeServiceDispositions);

    // When
    const shadowed = keys.filter((path) => {
      const segments = path.split(".");
      return segments
        .slice(1)
        .some(
          (_, index) =>
            composeServiceDispositions[segments.slice(0, index + 1).join(".")]?.disposition === "rejected",
        );
    });

    // Then
    expect(keys.length).toBeGreaterThan(0);
    expect(shadowed).toEqual([]);
  });
});
