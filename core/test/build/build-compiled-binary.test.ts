import { describe, expect, test } from "bun:test";

import {
  CompiledBinaryBuildError,
  type CompiledBinaryBuildRunner,
  buildCompiledBinary,
  createOpenTuiPruningPlugin,
  parseCompiledBinaryArgs,
  resolveOpenTuiNativeImport,
} from "../../../scripts/build-compiled-binary.ts";
import { opentuiNativeCatalog } from "../../../scripts/generated/opentui-native/catalog.generated.ts";

const releaseTargets = Object.entries(opentuiNativeCatalog.targetToNativeRoot);

describe("compiled binary OpenTUI native pruning", () => {
  test.each(releaseTargets)("keeps only the selected native root for %s", (target, selectedRoot) => {
    // Given: one of the five release targets and all eight catalog roots.
    // When: each exact native root is resolved for that target.
    const resolutions = opentuiNativeCatalog.allNativeRoots.map((root) => ({
      root,
      resolution: resolveOpenTuiNativeImport(target, root),
    }));

    // Then: the selected root resolves normally and the other seven use generated stubs.
    expect(resolutions.filter(({ resolution }) => resolution === undefined).map(({ root }) => root)).toEqual([
      selectedRoot,
    ]);
    expect(resolutions.filter(({ resolution }) => resolution !== undefined)).toEqual(
      opentuiNativeCatalog.allNativeRoots
        .filter((root) => root !== selectedRoot)
        .map((root) => ({ root, resolution: opentuiNativeCatalog.stubPathFor(target, root) })),
    );
  });

  test.each(releaseTargets)("leaves non-catalog imports untouched for %s", (target) => {
    // Given: imports near the OpenTUI native package namespace that are not exact catalog roots.
    const imports = [
      "@opentui/core",
      "@opentui/core/testing",
      "@opentui/core-linux-x64/index.js",
      "./@opentui/core-linux-x64",
      "@opentui/core-plan9-x64",
    ];

    // When: the imports are resolved for a release target.
    const resolutions = imports.map((path) => resolveOpenTuiNativeImport(target, path));

    // Then: every non-catalog import remains in Bun's normal resolver.
    expect(resolutions).toEqual(imports.map(() => undefined));
  });

  test("plugin registers the catalog exact-root filter", () => {
    // Given: the pruning plugin for one release target.
    const plugin = createOpenTuiPruningPlugin("linux-x64");

    // When: its public plugin metadata is inspected.
    const pluginName = plugin.name;

    // Then: it is the dedicated OpenTUI native pruning plugin.
    expect(pluginName).toBe("opentui-native-pruning");
  });

  test("build uses the release target and one pruning plugin", async () => {
    // Given: a build runner that records the programmatic Bun build configuration.
    let received: Bun.BuildConfig | undefined;
    const runner: CompiledBinaryBuildRunner = async (config) => {
      received = config;
      return { success: true, logs: [], outputs: [] };
    };

    // When: a versioned Linux binary is built.
    await buildCompiledBinary(
      { target: "linux-x64", outfile: "./dist/lando-linux-x64", version: "4.0.0-beta.1" },
      runner,
    );

    // Then: compile, bytecode, minification, sourcemap, define, and exactly one pruning plugin are preserved.
    expect(received).toMatchObject({
      target: "bun",
      format: "esm",
      compile: { target: "bun-linux-x64", outfile: "./dist/lando-linux-x64" },
      bytecode: true,
      minify: true,
      sourcemap: "external",
      define: {
        __LANDO_CORE_VERSION__: '"4.0.0-beta.1"',
        __LANDO_OPENTUI_NATIVE_ROOT__: JSON.stringify(opentuiNativeCatalog.targetToNativeRoot["linux-x64"]),
      },
    });
    expect(received?.plugins).toHaveLength(1);
    expect(received?.plugins?.[0]?.name).toBe("opentui-native-pruning");
  });

  test("build rejects with Bun diagnostics when the build output is unsuccessful", async () => {
    // Given: Bun reports a failed build with a diagnostic instead of rejecting.
    const diagnostic: Bun.BuildOutput["logs"][number] = {
      name: "BuildMessage",
      position: null,
      message: "Could not resolve the compiled entrypoint.",
      level: "error",
    };
    const runner: CompiledBinaryBuildRunner = async () => ({
      success: false,
      logs: [diagnostic],
      outputs: [],
    });

    // When: the failed output is returned through the compiled-binary build boundary.
    const build = buildCompiledBinary({ target: "linux-x64", outfile: "./dist/lando-linux-x64" }, runner);

    // Then: callers receive a typed failure that preserves Bun's diagnostics.
    await expect(build).rejects.toBeInstanceOf(CompiledBinaryBuildError);
    await expect(build).rejects.toMatchObject({
      name: "CompiledBinaryBuildError",
      diagnostics: [diagnostic],
    });
  });

  test("CLI accepts the normative Bun build flags and normalizes the target", () => {
    // Given: a Bun-prefixed target plus the required optimization flags and mixed value forms.
    const args = [
      "--target=bun-windows-x64",
      "--outfile",
      "./dist/lando-windows-x64.exe",
      "--version=4.0.0-beta.2",
      "--minify",
      "--sourcemap=external",
    ];

    // When: the wrapper parses its CLI arguments.
    const options = parseCompiledBinaryArgs(args);

    // Then: the target is normalized for platform selection and value inputs are preserved.
    expect(options).toEqual({
      target: "windows-x64",
      outfile: "./dist/lando-windows-x64.exe",
      version: "4.0.0-beta.2",
    });
  });
});
