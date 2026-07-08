import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";

import { type LandofileShape, ServiceName } from "@lando/core/schema";
import { AppPlanner, LandofileService } from "@lando/core/services";

import { initApp } from "../../src/cli/commands/init.ts";
import { LandofileServiceLive } from "../../src/landofile/service.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { nodeTsRecipeYaml } from "../../src/recipes/builtin/node-ts/manifest.ts";
import { nodeTsRenderer } from "../../src/recipes/builtin/node-ts/render.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

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
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
  hostPortPublish: "native" as const,
  routeProvider: true,
  tlsCertificates: "lando" as const,
  rootless: true,
  privilegedServices: false,
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

describe("node-ts recipe renderer", () => {
  test("emits exactly one file at .lando.ts", () => {
    const rendered = nodeTsRenderer.render({ appName: "demo-app", answers: {} });
    expect([...rendered.keys()]).toEqual([".lando.ts"]);
  });

  test("rendered .lando.ts contains no forbidden node builtin or URL-scheme import", () => {
    const rendered = nodeTsRenderer.render({ appName: "demo-app", answers: {} });
    const tsSource = rendered.get(".lando.ts");
    if (tsSource === undefined) throw new Error("expected .lando.ts to be rendered");
    const source = tsSource;

    const importPattern = /\b(?:import|require)\s*(?:\(\s*)?["'`]([^"'`]+)["'`]/g;
    const matchedSpecifiers: string[] = [];
    for (const match of source.matchAll(importPattern)) {
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

  test("manifest yaml advertises .lando.ts as the only emitted dest", () => {
    expect(nodeTsRecipeYaml).toContain("dest: .lando.ts");
    expect(nodeTsRecipeYaml).not.toContain("dest: .lando.yml");
  });
});

describe("lando init — programmatic Landofile (node-ts)", () => {
  test("writes .lando.ts (and not .lando.yml) at the expected path", async () => {
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
      expect(await Bun.file(join(result.directory, ".lando.ts")).exists()).toBe(true);
      expect(await Bun.file(join(result.directory, ".lando.yml")).exists()).toBe(false);
    });
  });

  test("LandofileService discovers and validates the generated .lando.ts (defaults)", async () => {
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

  test("renderer round-trips an app name containing apostrophes and backslashes via JSON.stringify", async () => {
    const trickyName = `quote\\and"backslash`;
    const rendered = nodeTsRenderer.render({ appName: trickyName, answers: {} });
    const tsSource = rendered.get(".lando.ts");
    if (tsSource === undefined) throw new Error("expected .lando.ts to be rendered");
    expect(tsSource).toContain(`name: ${JSON.stringify(trickyName)},`);
  });

  test("rendered .lando.ts file on disk is the renderer output under a // ownership marker", async () => {
    await withTempCwd(async (dir) => {
      const result = await initApp({
        cwd: dir,
        full: false,
        recipe: "node-ts",
        nonInteractive: true,
        answers: { name: "byte-parity-app" },
        postInitIO: { out: () => {}, err: () => {} },
      });

      const onDisk = await readFile(join(result.directory, ".lando.ts"), "utf8");
      const body = nodeTsRenderer.render({ appName: "byte-parity-app", answers: {} }).get(".lando.ts") ?? "";
      const markerLine =
        "// lando-generated:node-ts:.lando.ts — managed by Lando; delete this line to adopt this file.";
      expect(onDisk.split("\n")[0]).toBe(markerLine);
      expect(onDisk.slice(markerLine.length + 1)).toBe(body.endsWith("\n") ? body : `${body}\n`);
    });
  });
});
