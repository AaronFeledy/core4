import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import {
  collectComposeServiceKeyPaths,
  collectComposeTopLevelKeyPaths,
  compareComposeCoverage,
} from "../../../scripts/compose-schema.ts";

const fixturePath = resolve(import.meta.dirname, "fixtures/compose-schema.json");

describe("compose schema walker", () => {
  test("enumerates service paths through refs, unions, arrays, and pattern maps", async () => {
    const schema: unknown = await Bun.file(fixturePath).json();

    expect(collectComposeServiceKeyPaths(schema)).toEqual([
      "depends_on",
      "depends_on.*",
      "depends_on.*.condition",
      "image",
      "labels",
      "labels.*",
      "volumes",
      "volumes.type",
      "volumes.volume",
      "volumes.volume.subpath",
      "x-*",
    ]);
  });

  test("enumerates only project-level keys for top-level coverage", async () => {
    const schema: unknown = await Bun.file(fixturePath).json();

    expect(collectComposeTopLevelKeyPaths(schema)).toEqual(["name", "services", "version", "x-*"]);
  });

  test("reports unclassified schema paths and stale matrix entries", () => {
    expect(compareComposeCoverage(["image", "working_dir"], ["image", "obsolete"])).toEqual({
      missingFromMatrix: ["working_dir"],
      missingFromSchema: ["obsolete"],
    });
  });
});
