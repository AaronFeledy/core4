import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import rootManifest from "../../../package.json";
import { PLUGIN_NEW_TEMPLATE_IDS, materializePluginScaffold } from "../../src/operations/plugin-scaffold";

const repositoryRoot = resolve(import.meta.dirname, "../../..");

describe("plugin scaffold", () => {
  for (const template of PLUGIN_NEW_TEMPLATE_IDS) {
    test(`generates a compiling Effect4 plugin with passing tests for ${template}`, async () => {
      // Given: repo-local ignored fixtures resolve the installed SDK and Effect without installing or running Lando.
      const fixtureParent = join(repositoryRoot, "engine/test/.tmp");
      await mkdir(fixtureParent, { recursive: true });
      const destination = await mkdtemp(join(fixtureParent, "plugin-scaffold-"));
      try {
        // When
        const result = await materializePluginScaffold({
          name: "@lando/test-scaffold",
          destination,
          template,
          cspace: "test",
          description: "Scaffold test fixture",
        });

        // Then: compile and execute the generated plugin, not a source-text approximation.
        const packageJson = await Bun.file(join(destination, "package.json")).json();
        expect(packageJson.dependencies.effect).toBe(rootManifest.workspaces.catalog.effect);
        const sources = (
          await Promise.all(
            result.files
              .filter((path) => path.startsWith("src/") && path.endsWith(".ts"))
              .map((path) => Bun.file(join(destination, path)).text()),
          )
        ).join("\n");
        for (const shape of [
          "extends Context.Service<",
          "static readonly layer = Layer.effect(",
          ".of(",
          'Effect.fn("',
        ]) {
          expect(sources).toContain(shape);
        }
        for (const banned of [
          /export\s+(?:const|class|function)\s+\w*Live\b/,
          /Data\.TaggedError/,
          /Date\.now\s*\(/,
          /new Date\s*\(/,
          /@effect\//,
          /function\s+\w+\s*\([^)]*\)[^{]*\{\s*return\s+Effect\.gen\s*\(/,
          /Layer\.succeed\s*\([^,]+,\s*\{/,
          /\bisRecord\b/,
        ]) {
          expect(sources).not.toMatch(banned);
        }
        expect(packageJson.devDependencies.typescript).toBe("^5.9.0");
        const compiler = Bun.spawn(
          [process.execPath, join(repositoryRoot, "node_modules/typescript/bin/tsc"), "-p", "tsconfig.json"],
          { cwd: destination, stdout: "pipe", stderr: "pipe" },
        );
        const [compileCode, compileOutput, compileErrors] = await Promise.all([
          compiler.exited,
          new Response(compiler.stdout).text(),
          new Response(compiler.stderr).text(),
        ]);
        expect({ code: compileCode, stdout: compileOutput, stderr: compileErrors }).toEqual({
          code: 0,
          stdout: "",
          stderr: "",
        });
        const runner = Bun.spawn([process.execPath, "test", "./test/plugin.test.ts"], {
          cwd: destination,
          stdout: "pipe",
          stderr: "pipe",
        });
        const [testCode, testOutput, testErrors] = await Promise.all([
          runner.exited,
          new Response(runner.stdout).text(),
          new Response(runner.stderr).text(),
        ]);
        expect({ code: testCode, output: `${testOutput}${testErrors}` }).toMatchObject({ code: 0 });
        expect(`${testOutput}${testErrors}`).toContain("2 pass");
      } finally {
        await rm(destination, { recursive: true, force: true });
      }
    }, 20_000);
  }
});
