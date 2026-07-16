import { readdir } from "node:fs/promises";
import { resolve } from "node:path";

import { describe, expect, test } from "bun:test";

const repoRoot = resolve(import.meta.dirname, "../../..");
const generatorPath = resolve(repoRoot, "scripts/build-opentui-native-stubs.ts");
const generatedRoot = resolve(repoRoot, "scripts/generated/opentui-native");
const catalogPath = resolve(generatedRoot, "catalog.generated.ts");

const nativeRoots = [
  "@opentui/core-darwin-arm64",
  "@opentui/core-darwin-x64",
  "@opentui/core-linux-arm64",
  "@opentui/core-linux-arm64-musl",
  "@opentui/core-linux-x64",
  "@opentui/core-linux-x64-musl",
  "@opentui/core-win32-arm64",
  "@opentui/core-win32-x64",
] as const;

const targetToNativeRoot = {
  "darwin-arm64": "@opentui/core-darwin-arm64",
  "darwin-x64": "@opentui/core-darwin-x64",
  "linux-arm64": "@opentui/core-linux-arm64",
  "linux-x64": "@opentui/core-linux-x64",
  "windows-x64": "@opentui/core-win32-x64",
} as const;

const runGenerator = () =>
  Bun.spawnSync([process.execPath, generatorPath], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

describe("OpenTUI native stub catalog", () => {
  test("only the renderer workspace declares the OpenTUI dependency", async () => {
    const declarations: string[] = [];
    for (const pattern of [
      "core/package.json",
      "sdk/package.json",
      "container-runtime/package.json",
      "plugins/*/package.json",
    ]) {
      for await (const packagePath of new Bun.Glob(pattern).scan({ cwd: repoRoot, absolute: true })) {
        const manifest = (await Bun.file(packagePath).json()) as Record<
          string,
          Record<string, string> | string | undefined
        >;
        for (const section of [
          "dependencies",
          "devDependencies",
          "optionalDependencies",
          "peerDependencies",
        ]) {
          const dependencies = manifest[section];
          if (
            dependencies !== undefined &&
            typeof dependencies === "object" &&
            dependencies["@opentui/core"] !== undefined
          ) {
            declarations.push(packagePath);
          }
        }
      }
    }

    expect(declarations).toEqual([resolve(repoRoot, "plugins/renderer-lando/package.json")]);
  });

  test("generates the fixed roots, release mappings, and exact-root resolver contract", async () => {
    // Given the installed OpenTUI package, renderer dependency, and lockfile pins
    // When the catalog generator runs
    const proc = runGenerator();

    // Then the generated catalog exposes only the specified roots and targets
    expect({ exitCode: proc.exitCode, stderr: proc.stderr.toString() }).toMatchObject({ exitCode: 0 });
    const { opentuiNativeCatalog } = await import(catalogPath);
    expect(opentuiNativeCatalog.allNativeRoots).toEqual(nativeRoots);
    expect(opentuiNativeCatalog.targetToNativeRoot).toEqual(targetToNativeRoot);
    expect(opentuiNativeCatalog.rootImportFilter.test("@opentui/core-linux-x64")).toBeTrue();
    expect(opentuiNativeCatalog.rootImportFilter.test("@opentui/core-linux-x64/subpath")).toBeFalse();
    expect(opentuiNativeCatalog.rootImportFilter.test("@opentui/core/testing")).toBeFalse();
    expect(opentuiNativeCatalog.rootImportFilter.test("./@opentui/core-linux-x64")).toBeFalse();
    expect(opentuiNativeCatalog.stubPathFor("windows-x64", "@opentui/core-linux-x64")).toBe(
      resolve(generatedRoot, "stubs/windows-x64/core-linux-x64.generated.ts"),
    );
    expect(() => opentuiNativeCatalog.stubPathFor("windows-x64", "@opentui/core-win32-x64")).toThrow(
      /target native root/u,
    );
    expect(() => opentuiNativeCatalog.stubPathFor("windows-x64", "@opentui/core-linux-x64/subpath")).toThrow(
      /unknown OpenTUI native root/u,
    );
  });

  test("generates exactly 35 deterministic import-free throwing stubs", async () => {
    // Given a generated catalog
    // When every target stub directory is inspected
    const proc = runGenerator();
    expect(proc.exitCode).toBe(0);
    const targets = Object.keys(targetToNativeRoot);
    const files = (
      await Promise.all(
        targets.map(async (target) =>
          (await readdir(resolve(generatedRoot, "stubs", target))).map((file) => `${target}/${file}`),
        ),
      )
    ).flat();

    // Then each target has seven stable, import-free modules that name its mismatched root
    expect(files).toHaveLength(35);
    for (const relativePath of files) {
      const [target, file] = relativePath.split("/");
      const source = await Bun.file(resolve(generatedRoot, "stubs", relativePath)).text();
      expect(source).not.toMatch(/\b(?:import|require)\s*(?:\(|["'{*])/u);
      expect(source).toContain(
        `OpenTUI native package @opentui/${file?.replace(".generated.ts", "")} is unreachable`,
      );
      expect(source).toContain(`release target ${target}`);
      expect(source).toMatch(/^throw new Error\([\s\S]+\);\n$/u);
    }
  });

  test("fails closed when pinned package inputs diverge", async () => {
    // Given the generator's pinned input validator
    const module = await import(generatorPath);

    // When any independently pinned input diverges, then generation is rejected
    expect(() =>
      module.validatePinnedInputs({
        installedVersion: "0.4.4",
        literalBranchRoots: nativeRoots,
        rendererDependencyRange: "^0.4.3",
        lockResolution: "0.4.3",
      }),
    ).toThrow(/installed @opentui\/core version/u);
    expect(() =>
      module.validatePinnedInputs({
        installedVersion: "0.4.3",
        literalBranchRoots: nativeRoots.slice(1),
        rendererDependencyRange: "^0.4.3",
        lockResolution: "0.4.3",
      }),
    ).toThrow(/literal branch roots/u);
    expect(() =>
      module.validatePinnedInputs({
        installedVersion: "0.4.3",
        literalBranchRoots: nativeRoots,
        rendererDependencyRange: "~0.4.3",
        lockResolution: "0.4.3",
      }),
    ).toThrow(/renderer dependency range/u);
    expect(() =>
      module.validatePinnedInputs({
        installedVersion: "0.4.3",
        literalBranchRoots: nativeRoots,
        rendererDependencyRange: "^0.4.3",
        lockResolution: "0.4.4",
      }),
    ).toThrow(/bun.lock resolution/u);
  });

  test("is byte-stable on rerun", async () => {
    // Given one complete generation
    expect(runGenerator().exitCode).toBe(0);
    const before = new Map<string, string>();
    const catalog = await Bun.file(catalogPath).text();
    before.set("catalog.generated.ts", catalog);
    for (const target of Object.keys(targetToNativeRoot)) {
      for (const file of await readdir(resolve(generatedRoot, "stubs", target))) {
        const relativePath = `stubs/${target}/${file}`;
        before.set(relativePath, await Bun.file(resolve(generatedRoot, relativePath)).text());
      }
    }

    // When generation runs again
    expect(runGenerator().exitCode).toBe(0);

    // Then all 36 generated files remain byte-identical
    expect(before.size).toBe(36);
    for (const [relativePath, source] of before) {
      expect(await Bun.file(resolve(generatedRoot, relativePath)).text()).toBe(source);
    }
  });
});
