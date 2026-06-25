import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { checkEnvHelperBoundary } from "../../../scripts/check-env-helper-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => fs.mkdtemp(join(tmpdir(), "lando-env-helper-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await fs.mkdir(dirname(join(root, path)), { recursive: true });
  await fs.writeFile(join(root, path), content, "utf8");
};

describe("env helper boundary lint gate", () => {
  test("reports service imports of lando.env helpers and barrel escape hatches", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "plugins/service-lando/src/features/env.ts",
        'export const landoEnvFeature = { id: "lando.env" };\n',
      );
      await write(
        root,
        "plugins/service-lando/src/features/index.ts",
        'export { landoEnvFeature } from "./env";\n',
      );
      await write(
        root,
        "plugins/service-lando/src/services/evil.ts",
        'import { landoEnvFeature } from "../features/env"; export const evil = landoEnvFeature;\n',
      );
      await write(
        root,
        "plugins/service-lando/src/services/sneaky.ts",
        'import { landoEnvFeature } from "../features/index.ts"; export const sneaky = landoEnvFeature;\n',
      );

      const result = await checkEnvHelperBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) =>
            `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.line}:${offender.specifier}`,
        ),
      ).toEqual([
        "plugins/service-lando/src/services/evil.ts:1:../features/env",
        "plugins/service-lando/src/services/sneaky.ts:1:../features/index.ts",
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  test("passes for unrelated service imports and feature-local env helper imports", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "plugins/service-lando/src/features/env.ts",
        'import { helper } from "./internal"; export const landoEnvFeature = helper;\n',
      );
      await write(
        root,
        "plugins/service-lando/src/features/internal.ts",
        'export const helper = { id: "lando.env" };\n',
      );
      await write(
        root,
        "plugins/service-lando/src/services/clean.ts",
        'import { helper } from "../features/internal"; export const clean = helper;\n',
      );
      await write(
        root,
        "plugins/service-lando/src/services/fixture.test.ts",
        'import { landoEnvFeature } from "../features/env"; export const fixture = landoEnvFeature;\n',
      );

      expect(await checkEnvHelperBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
