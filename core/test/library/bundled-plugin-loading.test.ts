import { mkdir, mkdtemp, rename, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import corePackage from "../../package.json";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
const dependencyPackageRoot = resolve(repoRoot, "node_modules");
const fullBundledPluginNames = [
  "@lando/provider-lando",
  "@lando/provider-docker",
  "@lando/provider-podman",
  "@lando/service-lando",
  "@lando/logger-pretty",
  "@lando/renderer-lando",
  "@lando/notify-lando",
  "@lando/file-sync-mutagen",
  "@lando/ca-mkcert",
  "@lando/proxy-traefik",
  "@lando/ssh-agent",
  "@lando/template-handlebars",
  "@lando/template-mustache",
  "@lando/sql",
] as const;
const bundledPluginRuntimeDependencies = ["@opentui/core", "handlebars", "mustache"] as const;

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCommand = async (cmd: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

const runProbe = (source: string, cwd = repoRoot): Promise<RunResult> =>
  runCommand([process.execPath, "-e", source], cwd);

const preparePackedConsumer = async (): Promise<{ readonly root: string; readonly consumer: string }> => {
  const root = await mkdtemp(join(tmpdir(), "lando-core-bundled-opt-in-"));
  try {
    const archivePath = join(root, "lando-core.tgz");
    const pack = await runCommand(
      [process.execPath, "pm", "pack", "--filename", archivePath, "--ignore-scripts", "--quiet"],
      coreRoot,
    );
    expectProbeSucceeded(pack);

    const extracted = join(root, "extract");
    await mkdir(extracted);
    const extract = await runCommand(
      ["tar", "-xzf", archivePath, "-C", extracted, "package/package.json", "package/src"],
      root,
    );
    expectProbeSucceeded(extract);

    const consumer = join(root, "consumer");
    const dependencies = [
      ...Object.keys(corePackage.dependencies),
      "@standard-schema/spec",
      "fast-check",
      "pure-rand",
      ...fullBundledPluginNames,
      ...bundledPluginRuntimeDependencies,
    ].toSorted();
    for (const dependency of dependencies) {
      const destination = join(consumer, "node_modules", dependency);
      await mkdir(dirname(destination), { recursive: true });
      await symlink(join(dependencyPackageRoot, dependency), destination, "dir");
    }
    await rename(join(extracted, "package"), join(consumer, "node_modules/@lando/core"));
    return { root, consumer };
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  }
};

const compositionProbe = (entrySpecifiers: ReadonlyArray<string>): string =>
  [
    ...entrySpecifiers.map((entrySpecifier) => `await import(${JSON.stringify(entrySpecifier)});`),
    "const composition = await import('@lando/engine/composition');",
    "const pluginNames = composition.bundledPluginModules().map((module) => module.manifest.name);",
    "const templateNames = composition.landofileRuntimeInputs().templates.modules.map((module) => module.manifest.name);",
    "console.log(JSON.stringify({ pluginNames, templateNames }));",
  ].join("");

const expectProbeSucceeded = (result: RunResult): void => {
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stderr).toBe("");
};

describe("@lando/core bundled plugin loading", () => {
  test("bundled-only fails fast when the explicit bundled entry was not imported", async () => {
    // Given: a preload-free root import with no bundled composition installed.
    const probe = [
      "const { makeLandoRuntime } = await import('@lando/core');",
      "const { Effect, Layer } = await import('effect');",
      "const runtime = makeLandoRuntime({ bootstrap: 'plugins', plugins: { policy: 'bundled-only' } });",
      "const result = await Effect.runPromise(Effect.scoped(Effect.either(Layer.build(runtime))));",
      "if (result._tag === 'Right') process.exit(1);",
      "console.log(result.left._tag);",
      "console.log(result.left.message);",
    ].join("");

    // When: the host requests bundled discovery without opting into bundled plugins.
    const result = await runProbe(probe);

    // Then: runtime construction names the public opt-in entry in its tagged failure.
    expectProbeSucceeded(result);
    expect(result.stdout).toContain("LandoRuntimeBootstrapError\n");
    expect(result.stdout).toContain("@lando/core/bundled-plugins");
  });

  test("the explicit bundled-plugins entry installs the full bundled composition and runtime", async () => {
    // Given: a packed consumer with core's closure and the explicit bundled plugin packages installed.
    const fixture = await preparePackedConsumer();
    try {
      const probe = [
        "await import('@lando/core/bundled-plugins');",
        "const { makeLandoRuntime } = await import('@lando/core');",
        "const { PluginRegistry } = await import('@lando/core/services');",
        "const { Effect } = await import('effect');",
        "const runtime = makeLandoRuntime({ bootstrap: 'plugins', plugins: { policy: 'bundled-only' } });",
        "const loaded = Effect.flatMap(PluginRegistry, (registry) => registry.load('@lando/provider-lando'));",
        "const manifest = await Effect.runPromise(Effect.scoped(loaded.pipe(Effect.provide(runtime))));",
        "console.log(manifest.name);",
      ].join("");

      // When: a preload-free Bun process opts in, builds the runtime, and loads a bundled plugin.
      const result = await runProbe(probe, fixture.consumer);

      // Then: the packed bundled-only runtime resolves the default bundled provider through PluginRegistry.
      expectProbeSucceeded(result);
      expect(result.stdout).toBe("@lando/provider-lando\n");
    } finally {
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 60_000);

  test("a late base composition evaluation does not replace the full bundled composition", async () => {
    // Given: bundled composition is installed before a distinct evaluation of the base composition module.
    const probe = compositionProbe([
      "@lando/core/bundled-plugins",
      "./core/src/runtime/engine-composition.ts?late-base-install",
    ]);
    const fullExpected = `${JSON.stringify({
      pluginNames: fullBundledPluginNames,
      templateNames: fullBundledPluginNames,
    })}\n`;

    // When: the isolated process evaluates the base installer after the authoritative bundled installer.
    const result = await runProbe(probe);

    // Then: the late fallback keeps both bundled plugin and template modules installed.
    expectProbeSucceeded(result);
    expect(result.stdout).toBe(fullExpected);
  });

  test("the authoritative bundled composition upgrades an installed base composition", async () => {
    // Given: the library root installs the plugin-free base composition first.
    const probe = compositionProbe(["@lando/core", "@lando/core/bundled-plugins"]);
    const fullExpected = `${JSON.stringify({
      pluginNames: fullBundledPluginNames,
      templateNames: fullBundledPluginNames,
    })}\n`;

    // When: the isolated process imports the authoritative bundled composition afterward.
    const result = await runProbe(probe);

    // Then: the authoritative install upgrades both plugin and template modules to the full bundle.
    expectProbeSucceeded(result);
    expect(result.stdout).toBe(fullExpected);
  });

  test("the root composition is empty while the compiled CLI static composition remains full", async () => {
    // Given: isolated root-library and source-runtime composition entry points.
    const emptyExpected = `${JSON.stringify({ pluginNames: [], templateNames: [] })}\n`;
    const fullExpected = `${JSON.stringify({
      pluginNames: fullBundledPluginNames,
      templateNames: fullBundledPluginNames,
    })}\n`;

    // When: preload-free Bun processes import each composition independently.
    const [rootResult, compiledRuntimeResult] = await Promise.all([
      runProbe(compositionProbe(["@lando/core"])),
      runProbe(compositionProbe(["./core/src/cli/compiled-runtime.ts"])),
    ]);

    // Then: library root mode stays plugin-free and the CLI's static runtime keeps the complete bundle.
    expectProbeSucceeded(rootResult);
    expectProbeSucceeded(compiledRuntimeResult);
    expect(rootResult.stdout).toBe(emptyExpected);
    expect(compiledRuntimeResult.stdout).toBe(fullExpected);
  });
});
