import { appendFile, copyFile, mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { ComposeServiceKnobKey } from "@lando/sdk/schema";

import {
  type ComposeDispositionEntry,
  composeServiceDispositions,
  composeTopLevelDispositions,
} from "@lando/landofile/compose/dispositions";
import {
  checkComposeCoverage,
  formatComposeCoverageFailure,
} from "../../../scripts/check-compose-coverage.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");

describe("compose coverage gate", () => {
  test("accepts the committed schema, checksum pin, and disposition matrices", async () => {
    const result = await checkComposeCoverage();

    expect(result).toMatchObject({
      ok: true,
      checksum: { ok: true },
      service: { missingFromMatrix: [], missingFromSchema: [] },
      topLevel: { missingFromMatrix: [], missingFromSchema: [] },
    });
  });

  test("exits with a checksum error when the vendored schema bytes drift", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-compose-coverage-"));
    const copiedScript = join(root, "scripts/check-compose-coverage.ts");
    const copiedSchema = join(root, "vendor/compose/compose-spec.json");

    try {
      await Promise.all([
        mkdir(join(root, "scripts"), { recursive: true }),
        mkdir(join(root, "landofile/src/compose"), { recursive: true }),
        mkdir(join(root, "vendor/compose"), { recursive: true }),
        symlink(resolve(repoRoot, "node_modules"), join(root, "node_modules"), "dir"),
      ]);
      await Promise.all([
        copyFile(join(repoRoot, "scripts/check-compose-coverage.ts"), copiedScript),
        copyFile(join(repoRoot, "scripts/compose-schema.ts"), join(root, "scripts/compose-schema.ts")),
        copyFile(join(repoRoot, "scripts/compose-vendor.ts"), join(root, "scripts/compose-vendor.ts")),
        copyFile(
          join(repoRoot, "landofile/src/compose/dispositions.ts"),
          join(root, "landofile/src/compose/dispositions.ts"),
        ),
        copyFile(join(repoRoot, "vendor/compose/pin.json"), join(root, "vendor/compose/pin.json")),
        copyFile(join(repoRoot, "vendor/compose/compose-spec.json"), copiedSchema),
      ]);
      await appendFile(copiedSchema, "\n", "utf8");

      const child = Bun.spawn([process.execPath, "run", copiedScript], {
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("Vendored schema checksum mismatch:");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("gives every entry a rationale and every rejection a remediation pointer", () => {
    const entries: ReadonlyArray<readonly [string, ComposeDispositionEntry]> = [
      ...Object.entries(composeServiceDispositions),
      ...Object.entries(composeTopLevelDispositions),
    ];

    expect(entries.filter(([, entry]) => entry.rationale.length === 0)).toEqual([]);
    expect(
      entries.find(
        ([path, entry]) => entry.disposition === "rejected" && !entry.remediation?.includes(path),
      )?.[0],
    ).toBeUndefined();
  });

  test("classifies normalized, preserved, and rejected contract paths", () => {
    expect(
      Object.fromEntries(
        [
          "image",
          "build.context",
          "build.dockerfile_inline",
          "depends_on.*.condition",
          "healthcheck.test",
          "ports.target",
          "volumes.volume.subpath",
          "restart",
          "devices.permissions",
          "deploy.resources.limits.memory",
          "configs.target",
          "extends",
          "container_name",
          "network_mode",
          "links",
          "deploy.replicas",
        ].map((path) => [path, composeServiceDispositions[path]?.disposition]),
      ),
    ).toEqual({
      image: "normalized",
      "build.context": "normalized",
      "build.dockerfile_inline": "normalized",
      "depends_on.*.condition": "normalized",
      "healthcheck.test": "normalized",
      "ports.target": "normalized",
      "volumes.volume.subpath": "normalized",
      restart: "preserved",
      "devices.permissions": "preserved",
      "deploy.resources.limits.memory": "preserved",
      "configs.target": "preserved",
      extends: "rejected",
      container_name: "rejected",
      network_mode: "rejected",
      links: "rejected",
      "deploy.replicas": "rejected",
    });
  });

  test("classifies every runtime knob capability path as preserved", () => {
    for (const path of ComposeServiceKnobKey.literals) {
      expect(composeServiceDispositions[path]?.disposition).toBe("preserved");
    }
  });

  test("classifies top-level normalized and preserved contract paths", () => {
    expect(
      Object.fromEntries(
        ["services", "volumes", "networks", "configs", "secrets"].map((path) => [
          path,
          composeTopLevelDispositions[path]?.disposition,
        ]),
      ),
    ).toEqual({
      services: "normalized",
      volumes: "normalized",
      networks: "normalized",
      configs: "preserved",
      secrets: "preserved",
    });
  });

  test("names unclassified and stale paths in failure output", async () => {
    const { image: _removedImage, ...withoutImage } = composeServiceDispositions;
    const result = await checkComposeCoverage({
      serviceDispositions: {
        ...withoutImage,
        obsolete: {
          disposition: "rejected",
          rationale: "Synthetic stale entry.",
          remediation: "Remove the stale entry.",
        },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      service: { missingFromMatrix: ["image"], missingFromSchema: ["obsolete"] },
    });
    expect(formatComposeCoverageFailure(result)).toContain("Unclassified service key paths:\n  - image");
    expect(formatComposeCoverageFailure(result)).toContain(
      "Service matrix entries missing from schema:\n  - obsolete",
    );
  });
});
