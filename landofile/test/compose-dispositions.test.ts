import { describe, expect, test } from "bun:test";

import { ComposePreservedPathKey } from "@lando/sdk/schema";

import { composeServiceDispositions, composeTopLevelDispositions } from "../src/compose/dispositions.ts";
import { analyzeComposeDispositions, analyzeComposeRejections } from "../src/compose/rejections.ts";

describe("Compose disposition analysis", () => {
  test("reports every disposition in document order and descends through normalized parents", () => {
    // Given
    const parsed = {
      "x-fixture": { ignored: true },
      services: {
        entry: {
          ports: [{ target: 80, mode: "host" }],
        },
      },
    };

    // When
    const matches = analyzeComposeDispositions(parsed);

    // Then
    expect(
      matches.map(({ matrixPath, documentPath, service, disposition }) => [
        matrixPath,
        documentPath,
        service,
        disposition,
      ]),
    ).toEqual([
      ["x-*", "x-fixture", undefined, "preserved"],
      ["services", "services", undefined, "normalized"],
      ["ports", "services.entry.ports", "entry", "normalized"],
      ["ports.target", "services.entry.ports[0].target", "entry", "normalized"],
      ["ports.mode", "services.entry.ports[0].mode", "entry", "rejected"],
    ]);
    for (const match of matches) {
      const matrix = match.service === undefined ? composeTopLevelDispositions : composeServiceDispositions;
      expect(matrix[match.matrixPath]?.rationale).toBe(match.rationale);
    }
    expect(matches[0]).not.toHaveProperty("service");
    expect(matches[0]).not.toHaveProperty("remediation");
    expect(matches[4]?.remediation).toBe(composeServiceDispositions["ports.mode"]?.remediation);
  });

  test("projects rejection matches without changing their public shape", () => {
    // Given
    const parsed = {
      services: {
        entry: {
          ports: [{ target: 80, mode: "host" }],
        },
      },
    };

    // When
    const matches = analyzeComposeRejections(parsed);

    // Then
    const matrixEntry = composeServiceDispositions["ports.mode"];
    if (matrixEntry?.remediation === undefined) {
      throw new Error("ports.mode must stay a rejected key carrying remediation");
    }
    expect(matches).toEqual([
      {
        matrixPath: "ports.mode",
        documentPath: "services.entry.ports[0].mode",
        service: "entry",
        rationale: matrixEntry.rationale,
        remediation: matrixEntry.remediation,
      },
    ]);
    expect(matches[0]).not.toHaveProperty("disposition");
  });

  test("does not descend into Lando build discriminators", () => {
    // Given
    const parsed = {
      services: {
        entry: {
          build: { artifact: "dist", no_cache: true },
        },
      },
    };

    // When
    const matches = analyzeComposeDispositions(parsed);

    // Then
    expect(matches.map(({ matrixPath }) => matrixPath)).toEqual(["services", "build"]);
  });

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
});
