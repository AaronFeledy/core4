import { expect, test } from "bun:test";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { loadInstalledPlugin } from "@lando/engine/plugins/installed-plugin-loader";
import { importAuthorModule } from "@lando/landofile/author-modules";
import { PluginLoadError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { defaultBunSelfSpawner } from "../../src/cli/commands/bun-self-runner.ts";
import { pluginBuild } from "../../src/cli/commands/plugin-build.ts";

const temporaryDeclarationArtifacts = async (source: string): Promise<ReadonlyArray<string>> =>
  (await readdir(source)).filter((name) =>
    /^\.lando-plugin-build\.[0-9a-f-]+\.tsconfig\.(?:json|tsbuildinfo)$/u.test(name),
  );

const writeIncrementalPlugin = async (source: string, tsBuildInfoFile?: string) => {
  await mkdir(join(source, "src"), { recursive: true });
  await symlink(resolve(import.meta.dir, "../../../node_modules"), join(source, "node_modules"), "junction");
  await writeFile(
    join(source, "package.json"),
    JSON.stringify({
      name: "incremental-artifact-fixture",
      version: "1.0.0",
      type: "module",
      exports: { ".": "./src/index.ts" },
      landoPlugin: {
        name: "incremental-artifact-fixture",
        version: "1.0.0",
        api: 4,
        entry: "./src/index.ts",
      },
    }),
  );
  const tsconfig = `${JSON.stringify({
    compilerOptions: {
      incremental: true,
      ...(tsBuildInfoFile === undefined ? {} : { tsBuildInfoFile }),
      strict: true,
      skipLibCheck: true,
      module: "ESNext",
      target: "ESNext",
      moduleResolution: "bundler",
    },
    include: ["src/**/*.ts"],
  })}\n`;
  await writeFile(join(source, "tsconfig.json"), tsconfig);
  await writeFile(join(source, "src/index.ts"), "export const value = 1;\n");
  return tsconfig;
};

test("repeated real builds leave no per-invocation config or build-info files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-incremental-"));
  const source = join(root, "author");
  try {
    const tsconfig = await writeIncrementalPlugin(source);
    for (let iteration = 0; iteration < 2; iteration++) {
      expect((await Effect.runPromise(pluginBuild({ cwd: source }))).exitCode).toBe(0);
      expect(await temporaryDeclarationArtifacts(source)).toEqual([]);
      if (iteration === 0) await writeFile(join(source, "src/index.ts"), "export const value = 2;\n");
    }
    expect(await readFile(join(source, "dist/index.d.ts"), "utf8")).toContain("value = 2");
    expect(await readFile(join(source, "tsconfig.json"), "utf8")).toBe(tsconfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

test("overlapping real declaration builds leave no per-invocation build-info files", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-incremental-concurrent-"));
  const source = join(root, "author");
  const bothReady = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let declarationsStarted = 0;
  try {
    const tsconfig = await writeIncrementalPlugin(source);
    const spawner = {
      spawn: async (options: Parameters<typeof defaultBunSelfSpawner.spawn>[0]) => {
        if (options.cmd.includes("tsc")) {
          declarationsStarted++;
          if (declarationsStarted === 2) bothReady.resolve();
          await release.promise;
        }
        return defaultBunSelfSpawner.spawn(options);
      },
    };
    const first = Effect.runPromise(pluginBuild({ cwd: source, spawner }));
    const second = Effect.runPromise(pluginBuild({ cwd: source, spawner }));
    const deadline = setTimeout(() => {
      release.resolve();
      bothReady.reject(new Error("Both declaration builds did not become ready"));
    }, 20_000);
    try {
      await bothReady.promise;
      expect(declarationsStarted).toBe(2);
      expect(
        (await temporaryDeclarationArtifacts(source)).filter((name) => name.endsWith(".json")),
      ).toHaveLength(2);
      release.resolve();
      expect((await Promise.all([first, second])).map((result) => result.exitCode)).toEqual([0, 0]);
      expect(await temporaryDeclarationArtifacts(source)).toEqual([]);
      expect(await readFile(join(source, "tsconfig.json"), "utf8")).toBe(tsconfig);
    } finally {
      clearTimeout(deadline);
      release.resolve();
      await Promise.allSettled([first, second]);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);

test("real declaration build preserves an authored tsBuildInfoFile", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-incremental-authored-"));
  const source = join(root, "author");
  try {
    const tsconfig = await writeIncrementalPlugin(source, "./author.tsbuildinfo");
    const authoredPath = join(source, "author.tsbuildinfo");
    const authoredBytes = "author-owned build info\n";
    await writeFile(authoredPath, authoredBytes);
    expect((await Effect.runPromise(pluginBuild({ cwd: source }))).exitCode).toBe(0);
    expect(await readFile(authoredPath, "utf8")).toBe(authoredBytes);
    expect(await temporaryDeclarationArtifacts(source)).toEqual([]);
    expect(await readFile(join(source, "tsconfig.json"), "utf8")).toBe(tsconfig);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);

test("builds a standalone split artifact with lazy private dependencies and host peer identity", async () => {
  // Given a composite author project with a public operation and a lazy command.
  const root = await mkdtemp(join(tmpdir(), "lando-plugin-artifact-"));
  const marker = `lando-plugin-artifact-${root}`;
  try {
    const source = join(root, "author");
    await mkdir(join(source, "src"), { recursive: true });
    await symlink(
      resolve(import.meta.dir, "../../../node_modules"),
      join(source, "node_modules"),
      "junction",
    );
    await writeFile(
      join(source, "package.json"),
      JSON.stringify({
        name: "artifact-fixture",
        version: "1.0.0",
        type: "module",
        exports: { ".": "./src/index.ts", "./operations": "./src/operations.ts" },
        landoPlugin: { name: "artifact-fixture", version: "1.0.0", api: 4, entry: "./src/index.ts" },
        dependencies: { semver: "^7.8.5" },
        peerDependencies: { "@lando/sdk": "*", effect: "*" },
      }),
    );
    await writeFile(
      join(source, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: {
          composite: true,
          strict: true,
          skipLibCheck: true,
          module: "ESNext",
          target: "ESNext",
          moduleResolution: "bundler",
          allowImportingTsExtensions: true,
          types: ["bun"],
        },
        include: ["src/**/*.ts"],
      }),
    );
    await writeFile(
      join(source, "src/index.ts"),
      `
      import { Errors } from "@lando/sdk";
      import { PluginLoadError } from "@lando/sdk/errors";
      import { Effect } from "effect";
      import { succeed } from "effect/Effect";
      export const peers = [Errors.PluginLoadError, PluginLoadError, Effect.succeed, succeed];
      export const loadCommand = () => import("./command.ts");
    `,
    );
    await writeFile(
      join(source, "src/command.ts"),
      `
      export const run = () => import("./implementation.ts").then((module) => module.inspect());
    `,
    );
    await writeFile(
      join(source, "src/implementation.ts"),
      `
      import { valid } from "semver";
      Reflect.set(globalThis, ${JSON.stringify(marker)}, true);
      export const inspect = () => valid("1.2.3");
    `,
    );
    await writeFile(join(source, "src/operations.ts"), 'export { inspect } from "./implementation.ts";\n');

    // When the shared builder emits an artifact relocated away from source and node_modules.
    const result = await Effect.runPromise(pluginBuild({ cwd: source }));
    expect(result.exitCode).toBe(0);
    const artifact = join(root, "installed");
    await cp(join(source, "dist"), artifact, { recursive: true });
    await rm(source, { recursive: true, force: true });
    const loaded = await loadInstalledPlugin(artifact);
    const loadCommand = loaded.module?.loadCommand;
    if (typeof loadCommand !== "function") throw new TypeError("Artifact must export loadCommand");
    const command: unknown = await loadCommand();

    // Then descriptor/help loading stays lazy, peers stay host-owned, and private code is portable.
    expect(loaded.manifest.entry).toBe("./index.js");
    expect(loaded.module?.peers).toEqual([PluginLoadError, PluginLoadError, Effect.succeed, Effect.succeed]);
    expect(Reflect.has(globalThis, marker)).toBe(false);
    if (
      typeof command !== "object" ||
      command === null ||
      !("run" in command) ||
      typeof command.run !== "function"
    ) {
      throw new TypeError("Artifact command must export run");
    }
    expect(await command.run()).toBe("1.2.3");
    const operations = await importAuthorModule(join(artifact, "operations.js"));
    if (
      typeof operations !== "object" ||
      operations === null ||
      !("inspect" in operations) ||
      typeof operations.inspect !== "function"
    ) {
      throw new TypeError("Artifact must export inspect");
    }
    expect(operations.inspect()).toBe("1.2.3");
  } finally {
    Reflect.deleteProperty(globalThis, marker);
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
