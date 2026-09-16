import { expect, spyOn, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Effect } from "effect";
import * as cache from "../../src/cache/app-plan.ts";
import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

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
    planner.plan(landofile, TestRuntimeProvider.capabilities),
  ).pipe(Effect.provide(AppPlannerLive), Effect.provide(PluginRegistryLive), Effect.provide(FileSystemLive));
};

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
      ]);
      expect(db?.configSourceInputs?.map((source) => source.key).sort()).toEqual(["dir", "server"]);
    } finally {
      keys.mockRestore();
    }
  }));
