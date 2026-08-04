import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

import { rendererRule } from "../../../scripts/boundary/rules/renderer.ts";
import { checkRendererBoundary } from "../../../scripts/check-renderer-boundary.ts";

const makeFixtureRoot = async (): Promise<string> => mkdtemp(join(tmpdir(), "lando-renderer-boundary-"));

const write = async (root: string, path: string, content: string): Promise<void> => {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), content, "utf8");
};

describe("renderer boundary lint gate", () => {
  test("keeps the public gate messages stable", () => {
    expect(rendererRule.passMessage).toBe("Renderer boundary check passed.");
    expect(rendererRule.failureHeadline).toBe(
      "Renderer boundary check failed. Direct console/process writes must route through the Renderer boundary.",
    );
  });

  test("passes when direct writes are confined to explicit carve-outs", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/cli/oclif/pre-renderer.ts", "console.log('first paint');\n");
      await write(root, "core/bin/lando.ts", "process.stdout.write('banner');\n");
      await write(root, "core/src/cli/commands/ok.ts", "export const ok = true;\n");

      expect(await checkRendererBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports source direct writes outside carve-outs", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/recipes/bad.ts", "export const bad = () => console.error('bad');\n");
      await write(root, "core/src/recipes/table.ts", "export const table = () => console.table([]);\n");
      await write(root, "plugins/example/src/bad.ts", "process.stderr.write('bad');\n");

      const result = await checkRendererBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/recipes/bad.ts:1:console.error",
        "core/src/recipes/table.ts:1:console.table",
        "plugins/example/src/bad.ts:1:process.stderr.write",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("carves out interaction service live-layer prompt IO", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(
        root,
        "core/src/interaction/service.ts",
        "console.warn('fallback');\nprocess.stdout.write('prompt');\n",
      );
      await write(root, "core/src/cli/commands/ok.ts", "export const ok = true;\n");

      expect(await checkRendererBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("ignores test files and non-call property access", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/recipes/allowed.test.ts", "console.log('test only');\n");
      await write(
        root,
        "core/src/recipes/reference.ts",
        "export const stream = process.stdout;\nexport const log = console.log;\n",
      );
      await write(root, "core/src/recipes/ok.ts", "export const ok = true;\n");

      expect(await checkRendererBoundary({ root })).toEqual({ ok: true, offenders: [] });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("reports process.stdout.write and nested console calls by line", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "core/src/cli/commands/out.ts", "process.stdout.write('x');\n");
      await write(
        root,
        "plugins/example/src/nested.ts",
        "export const run = () => {\n  console.info('a');\n  console.debug('b');\n};\n",
      );

      const result = await checkRendererBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file)}:${offender.line}:${offender.match}`,
        ),
      ).toEqual([
        "core/src/cli/commands/out.ts:1:process.stdout.write",
        "plugins/example/src/nested.ts:2:console.info",
        "plugins/example/src/nested.ts:3:console.debug",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("covers private primitive packages in the shipped-source scope", async () => {
    const root = await makeFixtureRoot();
    try {
      await write(root, "paths/src/leak.ts", "console.log('x');\n");
      await write(root, "state-store/src/leak.ts", "console.log('x');\n");

      const result = await checkRendererBoundary({ root });

      expect(result.ok).toBe(false);
      expect(
        result.offenders.map(
          (offender) => `${relative(root, offender.file).replaceAll("\\", "/")}:${offender.match}`,
        ),
      ).toEqual(["paths/src/leak.ts:console.log", "state-store/src/leak.ts:console.log"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
