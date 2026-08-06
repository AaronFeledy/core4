import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkGeneratedOutput } from "../../../scripts/check-generated-output.ts";

const BANNER = "/**\n * **GENERATED FILE** — do not edit by hand.\n */\n";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-generated-output-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("generated output boundary lint gate", () => {
  test("reports generated-path source without the standard banner", async () => {
    const root = await makeFixtureRoot();
    try {
      // Given: source under a generated path segment without the standard banner.
      await write(root, "core/src/plugins/generated/bundled.ts", "export const bundled = [];\n");

      // When: the generated-output boundary is checked.
      const result = await checkGeneratedOutput({ root });

      // Then: the source is reported as missing the banner.
      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/plugins/generated/bundled.ts:1:missing **GENERATED FILE** — do not edit by hand. banner",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes generated-path source with the standard banner", async () => {
    const root = await makeFixtureRoot();
    try {
      // Given: source under a generated path segment with the standard banner.
      await write(root, "sdk/src/schema/generated/artifact.ts", `${BANNER}export const artifact = {};\n`);

      // When: the generated-output boundary is checked.
      const result = await checkGeneratedOutput({ root });

      // Then: the source passes.
      expect(result).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports bannered source outside a generated path", async () => {
    const root = await makeFixtureRoot();
    try {
      // Given: bannered source outside a generated path and the allowlist.
      await write(root, "plugins/example/src/handwritten.ts", `${BANNER}export const handwritten = true;\n`);

      // When: the generated-output boundary is checked.
      const result = await checkGeneratedOutput({ root });

      // Then: the misplaced generated output is reported.
      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.match}`,
        ),
      ).toEqual(["plugins/example/src/handwritten.ts:2:**GENERATED FILE** banner outside generated/ path"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("passes allowlisted bannered source outside a generated path", async () => {
    const root = await makeFixtureRoot();
    try {
      // Given: bannered source at an explicit allowlisted path.
      await write(root, "core/src/recipes/bundled.ts", `${BANNER}export const recipes = {};\n`);

      // When: the generated-output boundary is checked.
      const result = await checkGeneratedOutput({ root });

      // Then: the allowlisted source passes.
      expect(result).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("excludes test source under a generated path", async () => {
    const root = await makeFixtureRoot();
    try {
      // Given: bannerless test source under a generated path segment.
      await write(root, "core/src/runtime/generated/layer.test.ts", "export const fixture = true;\n");

      // When: the generated-output boundary is checked.
      const result = await checkGeneratedOutput({ root });

      // Then: test source is excluded.
      expect(result).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
