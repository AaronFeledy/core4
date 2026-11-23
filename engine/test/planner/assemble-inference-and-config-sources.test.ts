import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileValidationError } from "@lando/sdk/errors";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import * as cache from "../../src/cache/app-plan.ts";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { pathsServiceLayer } from "../paths-service.ts";

const withTempCwd = async (run: (root: string) => Promise<void>) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-inference-config-plan-")));
  const previous = process.cwd();
  try {
    process.chdir(root);
    await writeFile(join(root, ".lando.yml"), "name: merge-seam\nruntime: 4\n");
    await writeFile(join(root, ".nvmrc"), "22.11.0\n");
    await writeFile(join(root, "server.conf"), "listen 80;\n");
    await mkdir(join(root, "conf"));
    await run(root);
  } finally {
    process.chdir(previous);
    await rm(root, { recursive: true, force: true });
  }
};

const planBoth = () => {
  const landofile: LandofileShape = {
    name: "merge-seam",
    runtime: 4,
    services: {
      [ServiceName.make("web")]: { type: "node" },
      [ServiceName.make("db")]: {
        type: "compose",
        image: "postgres:16",
        home: false,
        config: { server: "server.conf", dir: "conf" },
      },
    },
  };
  return Effect.flatMap(AppPlanner, (planner) =>
    planTestLandofile(planner, landofile, TestRuntimeProvider.capabilities),
  ).pipe(
    Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(pathsServiceLayer()))),
    Effect.provide(PluginRegistryLayer.layer),
    Effect.provide(BunFileSystem.layer),
  );
};

const planLandofile = (landofile: LandofileShape) =>
  Effect.flatMap(AppPlanner, (planner) =>
    planTestLandofile(planner, landofile, TestRuntimeProvider.capabilities),
  ).pipe(
    Effect.provide(AppPlannerLayer.layer.pipe(Layer.provide(pathsServiceLayer()))),
    Effect.provide(PluginRegistryLayer.layer),
    Effect.provide(BunFileSystem.layer),
  );

test("keeps Node project-file fingerprints and catalog config sources in one cache key", () =>
  withTempCwd(async () => {
    const keys = spyOn(cache, "deriveAppPlanCacheKey");
    try {
      await Effect.runPromise(planBoth());
      const input = keys.mock.calls.at(-1)?.[0] as
        | {
            readonly serviceInputs?: {
              readonly composition?: {
                readonly services?: ReadonlyArray<{
                  readonly name: string;
                  readonly projectFiles?: ReadonlyArray<{
                    readonly path: string;
                    readonly present: boolean;
                    readonly sha256?: string;
                  }>;
                  readonly configSourceInputs?: ReadonlyArray<{ readonly key: string }>;
                }>;
              };
            };
          }
        | undefined;
      const services = input?.serviceInputs?.composition?.services ?? [];
      const web = services.find((service) => service.name === "web");
      const db = services.find((service) => service.name === "db");
      expect(web?.projectFiles).toEqual([
        { path: ".nvmrc", present: true, sha256: expect.any(String) },
        { path: "package.json", present: false },
        { path: ".yarnrc.yml", present: false },
      ]);
      expect(db?.configSourceInputs?.map((source) => source.key).sort()).toEqual(["dir", "server"]);
    } finally {
      keys.mockRestore();
    }
  }));

import { planTestLandofile } from "../compiled-landofile.ts";

test("attributes a Node inference conflict to the project file that caused it", () =>
  withTempCwd(async (root) => {
    await writeFile(join(root, ".nvmrc"), "lts/*\n");
    await writeFile(join(root, "package.json"), JSON.stringify({ engines: { node: "^24" } }));
    const result = await Effect.runPromise(
      Effect.result(
        planLandofile({
          name: "conflict",
          runtime: 4,
          services: { [ServiceName.make("web")]: { type: "node" } },
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(LandofileValidationError);
      if (result.failure instanceof LandofileValidationError) {
        expect(result.failure.file).toBe(join(root, ".nvmrc"));
        expect(result.failure.issues).toMatchObject([
          {
            path: ["services", "web"],
            source: { layer: "project-file", file: join(root, ".nvmrc"), path: [] },
          },
        ]);
      }
    }
  }));

test("attributes a nested packageRoot conflict to the nested project file", () =>
  withTempCwd(async (root) => {
    const nested = join(root, "apps", "web");
    await mkdir(nested, { recursive: true });
    await writeFile(join(nested, ".nvmrc"), "lts/*\n");
    await writeFile(join(nested, "package.json"), JSON.stringify({ engines: { node: "^24" } }));
    const result = await Effect.runPromise(
      Effect.result(
        planLandofile({
          name: "nested-conflict",
          runtime: 4,
          services: { [ServiceName.make("web")]: { type: "node", packageRoot: "apps/web" } },
        }),
      ),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure") {
      expect(result.failure).toBeInstanceOf(LandofileValidationError);
      if (result.failure instanceof LandofileValidationError) {
        expect(result.failure.file).toBe(join(root, "apps", "web", ".nvmrc"));
        expect(result.failure.issues).toMatchObject([
          {
            path: ["services", "web"],
            source: { layer: "project-file", file: join(root, "apps", "web", ".nvmrc"), path: [] },
          },
        ]);
      }
    }
  }));
