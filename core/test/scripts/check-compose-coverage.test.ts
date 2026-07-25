import { describe, expect, test } from "bun:test";

import {
  checkComposeCoverage,
  formatComposeCoverageFailure,
} from "../../../scripts/check-compose-coverage.ts";
import {
  type ComposeDispositionEntry,
  composeServiceDispositions,
  composeTopLevelDispositions,
} from "../../src/landofile/compose/dispositions.ts";

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

  test("gives every entry a rationale and every rejection a remediation pointer", () => {
    const entries: ReadonlyArray<ComposeDispositionEntry> = [
      ...Object.values(composeServiceDispositions),
      ...Object.values(composeTopLevelDispositions),
    ];

    expect(entries.filter((entry) => entry.rationale.length === 0)).toEqual([]);
    expect(
      entries.filter((entry) => entry.disposition === "rejected" && (entry.remediation?.length ?? 0) === 0),
    ).toEqual([]);
  });

  test("classifies normalized, preserved, and rejected contract paths", () => {
    expect(
      Object.fromEntries(
        [
          "image",
          "build.context",
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
