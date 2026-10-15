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
      "        MIXED: 'prefix-${secret:OTHER}'",
      "",
    ].join("\n"),
    async (root) => {
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
      );
      expect(result.valid).toBe(false);
      expect(result.violations.map((violation) => violation.path)).toEqual([
        ["services", "web", "build", "args", "TOKEN"],
        ["services", "web", "build", "args", "MIXED"],
      ]);
      expect(result.violations[0]?.suggestion).toContain("environment");
      expect(result.violations[0]?.message).toContain("TOKEN");
      expect(result.violations[1]?.message).toContain("MIXED");
      expect(result.violations[0]?.message).not.toMatch(/\$\{secret:/);
      expect(result.violations[1]?.message).not.toContain("prefix-");
    },
  );
});

test("still reports a build-arg violation when another expression in the file fails", async () => {
  await withApp(
    [
      "name: secret-lint-build-args-and-expression",
      "runtime: 4",
      "services:",
      "  database:",
      "    type: mariadb",
      '    database: "{{ app.nope }}"',
      "  web:",
      "    type: node:22",
      "    primary: true",
      "    build:",
      "      context: .",
      "      args:",
      "        TOKEN: 'visible-leak-${secret:op://vault/item/field}'",
      "",
    ].join("\n"),
    async (root) => {
      const result = await Effect.runPromise(
        appConfigLint({ cwd: root }).pipe(Effect.provide(PluginRegistryLayer.layer)),
      );
      expect(result.valid).toBe(false);
      expect(result.violations).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            path: ["services", "web", "build", "args", "TOKEN"],
            suggestion: expect.stringContaining("environment"),
          }),
          expect.objectContaining({ path: ["services", "database", "database"] }),
        ]),
      );
      const buildArg = result.violations.find(
        (violation) =>
          violation.path[0] === "services" && violation.path[1] === "web" && violation.path[3] === "args",
      );
      expect(buildArg?.message).not.toContain("visible-leak");
      expect(buildArg?.message).not.toContain("op://");
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
