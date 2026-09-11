import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { type LandofileShape, ServiceName } from "@lando/core/schema";
import { AppPlanner, LandofileService } from "@lando/core/services";
import { InitTargetExistsError } from "@lando/sdk/errors";

import { PluginRegistryLive } from "@lando/engine/plugins/registry";
import { AppPlannerLive } from "@lando/engine/services/planner";
import { initApp } from "../../src/cli/commands/init.ts";
import { nodeTsRecipeYaml } from "../../src/recipes/builtin/node-ts/manifest.ts";
import { TestLandofileServiceLive as LandofileServiceLive } from "../_support/landofile-layer.ts";
import { previewBuiltinRecipe } from "../_support/recipe-output.ts";

const FORBIDDEN_RUNTIME_BUILTINS = [
  "fs",
  "fs/promises",
  "child_process",
  "http",
  "https",
  "net",
  "tls",
  "dns",
  "worker_threads",
];

const FORBIDDEN_URL_SCHEMES = ["http://", "https://", "file://", "data:"];

const providerCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceLogSources: true,
  serviceHealth: "native" as const,
  hostReachability: "native" as const,
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native" as const,
  copyMounts: true,
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none" as const,
  serviceFileCopy: "none" as const,
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "native" as const,
  routeProvider: true,
  tlsCertificates: "lando" as const,
  rootless: true,
  privilegedServices: false,
  architectureEmulation: false,
  composeSpec: "native" as const,
  providerExtensions: ["compose"],
};

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-node-ts-")));
  const previousCwd = process.cwd();
  const previousDataRoot = process.env.LANDO_USER_DATA_ROOT;
  process.env.LANDO_USER_DATA_ROOT = join(dir, "lando-data");
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    if (previousDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
    else process.env.LANDO_USER_DATA_ROOT = previousDataRoot;
    await rm(dir, { recursive: true, force: true });
  }
};

const discoverFrom = async (cwd: string) => {
  const previousCwd = process.cwd();
  try {
    process.chdir(cwd);
    return await Effect.runPromise(
      Effect.flatMap(LandofileService, (service) => service.discover).pipe(
        Effect.provide(LandofileServiceLive),
      ),
    );
  } finally {
    process.chdir(previousCwd);
  }
};

const withEnv = async <T>(
  vars: Readonly<Record<string, string | undefined>>,
  run: () => Promise<T>,
): Promise<T> => {
  const previous: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) previous[key] = process.env[key];
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const planLandofile = (landofile: LandofileShape) =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, providerCapabilities)).pipe(
      Effect.provide(AppPlannerLive),
      Effect.provide(PluginRegistryLive),
    ),
  );

describe("node-ts recipe pipeline", () => {
  test("refuses when a TypeScript Landofile already exists at the destination", async () => {
    await withTempCwd(async (dir) => {
      const destination = join(dir, "existing");
      await mkdir(destination);
      await Bun.write(join(destination, ".lando.ts"), 'export default { name: "already" };\n');

      await expect(
        initApp({
          cwd: dir,
          destination,
          full: false,
          recipe: "lamp",
          name: "existing",
          nonInteractive: true,
          runPostInit: false,
        }),
      ).rejects.toBeInstanceOf(InitTargetExistsError);
      expect(await Bun.file(join(destination, ".lando.yml")).exists()).toBe(false);
      expect(await Bun.file(join(destination, ".lando.ts")).text()).toContain("already");
    });
  });

  test("emits exactly one canonical Landofile at .lando.yml", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-ts",
        nonInteractive: true,
        answers: { name: "demo-app" },
        runPostInit: false,
      });
      expect(await Bun.file(join(result.directory, ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(result.directory, ".lando.ts")).exists()).toBe(false);
      expect(result.skippedScaffold).toEqual([]);
    });
  });

  test("encoded node-ts Landofile contains no forbidden node builtin or URL-scheme import", async () => {
    const { text: tsSource } = await previewBuiltinRecipe("node-ts", "demo-app");

    const importPattern = /\b(?:import|require)\s*(?:\(\s*)?["'`]([^"'`]+)["'`]/g;
    const matchedSpecifiers: string[] = [];
    for (const match of tsSource.matchAll(importPattern)) {
      matchedSpecifiers.push(match[1] as string);
    }
    expect(matchedSpecifiers).toEqual([]);

    for (const builtin of FORBIDDEN_RUNTIME_BUILTINS) {
      expect(tsSource).not.toContain(`"${builtin}"`);
      expect(tsSource).not.toContain(`'${builtin}'`);
      expect(tsSource).not.toContain(`"node:${builtin}"`);
      expect(tsSource).not.toContain(`'node:${builtin}'`);
    }
    for (const scheme of FORBIDDEN_URL_SCHEMES) {
      expect(tsSource).not.toContain(scheme);
    }
  });

  test("manifest yaml advertises .lando.yml as the only emitted dest", () => {
    expect(nodeTsRecipeYaml).toContain("dest: .lando.yml");
    expect(nodeTsRecipeYaml).not.toContain("dest: .lando.ts");
  });
});

describe("lando init — canonical Landofile (node-ts)", () => {
  test("writes .lando.yml (and not .lando.ts) at the expected path", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-ts",
        nonInteractive: true,
        answers: { name: "node-ts-app" },
        postInitIO: { out: () => {}, err: () => {} },
      });

      expect(result.appName).toBe("node-ts-app");
      expect(await Bun.file(join(result.directory, ".lando.yml")).exists()).toBe(true);
      expect(await Bun.file(join(result.directory, ".lando.ts")).exists()).toBe(false);
    });
  });

  test("LandofileService discovers and validates the generated .lando.yml (defaults)", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-ts",
        nonInteractive: true,
        answers: { name: "discovered-ts-app" },
        postInitIO: { out: () => {}, err: () => {} },
      });

      await withEnv({ LANDO_NODE_VERSION: undefined, NODE_ENV: undefined }, async () => {
        const landofile = await discoverFrom(result.directory);
        expect(landofile.name).toBe("discovered-ts-app");
        const web = landofile.services?.[ServiceName.make("web")];
        expect(web).toBeDefined();
        expect(web?.image).toBe("node:lts");
        expect(web?.environment).toEqual({ NODE_ENV: "development" });
      });
    });
  });

  test("respects LANDO_NODE_VERSION at LandofileService load time", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-ts",
        nonInteractive: true,
        answers: { name: "env-driven-ts-app" },
        postInitIO: { out: () => {}, err: () => {} },
      });

      await withEnv({ LANDO_NODE_VERSION: "22", NODE_ENV: "production" }, async () => {
        const landofile = await discoverFrom(result.directory);
        const web = landofile.services?.[ServiceName.make("web")];
        expect(web?.image).toBe("node:22");
        expect(web?.environment).toEqual({ NODE_ENV: "production" });
      });
    });
  });

  test("generated Landofile is compatible with AppPlanner.plan", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-ts",
        nonInteractive: true,
        answers: { name: "plannable-ts-app" },
        postInitIO: { out: () => {}, err: () => {} },
      });

      await withEnv({ LANDO_NODE_VERSION: undefined, NODE_ENV: undefined }, async () => {
        const landofile = await discoverFrom(result.directory);
        const appPlan = await planLandofile(landofile);
        expect(appPlan.name).toBe("plannable-ts-app");
        expect(appPlan.services[ServiceName.make("web")]).toBeDefined();
      });
    });
  });

  test("encoder round-trips an app name containing quotes and backslashes", async () => {
    // Lando's own reader is the oracle here: the emitted provenance carries an
    // unquoted `packageName: @lando/recipe-node-ts`, which a general YAML
    // parser rejects on the reserved `@` indicator even though every reader on
    // the production path accepts it.
    const trickyName = `quote\\and"backslash`;
    const { text } = await previewBuiltinRecipe("node-ts", trickyName);
    await withTempCwd(async (dir) => {
      await writeFile(join(dir, ".lando.yml"), text, "utf8");
      const landofile = await discoverFrom(dir);
      expect(landofile.name).toBe(trickyName);
    });
  });

  test("canonical .lando.yml on disk is byte-identical to the preview without ownership markers", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-ts",
        nonInteractive: true,
        answers: { name: "byte-parity-app" },
        postInitIO: { out: () => {}, err: () => {} },
      });

      const onDisk = await readFile(join(result.directory, ".lando.yml"), "utf8");
      const { text } = await previewBuiltinRecipe("node-ts", "byte-parity-app", result.answers);
      expect(onDisk).not.toContain("lando-generated");
      expect(onDisk).toBe(text);
    });
  });
});
