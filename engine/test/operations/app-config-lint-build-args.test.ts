import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { appConfigLint } from "../../src/operations/app-config-lint.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";

const withApp = async (contents: string, run: (root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), "lando-lint-build-args-"));
  try {
    await writeFile(join(root, ".lando.yml"), contents);
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

test("reports a secret reference in compose build.args as a lint violation", async () => {
  await withApp(
    [
      "name: secret-lint-build-args",
      "runtime: 4",
      "services:",
      "  web:",
      "    type: node:22",
      "    primary: true",
      "    build:",
      "      context: .",
      "      args:",
      "        TOKEN: '${secret:TOKEN}'",
      "        MIXED: prefix-${secret:OTHER}",
      "",
    ].join("\n"),
    async (root) => {
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toMatchObject([
        {
          path: ["services", "web", "build", "args", "TOKEN"],
          message: expect.stringContaining("${secret:TOKEN}"),
          suggestion: expect.stringContaining("environment"),
        },
        {
          path: ["services", "web", "build", "args", "MIXED"],
          message: expect.stringContaining("${secret:OTHER}"),
        },
      ]);
    },
  );
});

test("still accepts exact secret references on service environment values", async () => {
  await withApp(
    [
      "name: secret-lint-environment",
      "runtime: 4",
      "services:",
      "  web:",
      "    type: node:22",
      "    primary: true",
      "    environment:",
      "      TOKEN: '${secret:TOKEN}'",
      "",
    ].join("\n"),
    async (root) => {
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
      );
      expect(result.valid).toBe(true);
      expect(result.violations).toEqual([]);
    },
  );
});
