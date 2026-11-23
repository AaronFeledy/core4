import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, type LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { Cause, Effect, Exit, Layer } from "effect";
import * as PluginRegistryLayer from "../../src/plugins/registry.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import * as AppPlannerLayer from "../../src/services/planner.ts";
import { literalTestLandofile } from "../compiled-landofile.ts";
import { pathsServiceLayer, testPaths } from "../paths-service.ts";

const document = {
  name: "paths-service-app",
  runtime: 4 as const,
  services: {
    [ServiceName.make("web")]: { type: "compose", image: "alpine:3.22", home: false },
  },
} satisfies LandofileShape;

const withRoot = async <T>(run: (appRoot: string, dataRoot: string) => Promise<T>): Promise<T> => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-planner-paths-")));
  const appRoot = join(root, "app");
  const dataRoot = join(root, "data");
  await mkdir(appRoot, { recursive: true });
  await mkdir(dataRoot, { recursive: true });
  try {
    return await run(appRoot, dataRoot);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("AppPlanner PathsService wiring", () => {
  test("Given AppPlanner.layer without PathsService, When planned, Then the effect stays incomplete", async () => {
    await withRoot(async (appRoot) => {
      // When: planner layer is provided registry + filesystem but not PathsService.
      // Intentionally omit PathsService: runtime must fail closed; widen R for runPromiseExit.
      const incomplete = Effect.flatMap(AppPlanner, (planner) =>
        planner.plan(literalTestLandofile(document, appRoot), TestRuntimeProvider.capabilities),
      ).pipe(
        Effect.provide(
          AppPlannerLayer.layer.pipe(
            Layer.provide(Layer.mergeAll(PluginRegistryLayer.layer, BunFileSystem.layer)),
          ),
        ),
      );
      const exit = await Effect.runPromiseExit(incomplete as Effect.Effect<unknown, unknown, never>);

      // Then: missing PathsService is a defect, not a successful plan.
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) throw new Error("expected missing PathsService to fail");
      const message = Cause.pretty(exit.cause);
      expect(message).toMatch(/PathsService|Service not found/i);
    });
  });

  test("Given a PathsService userDataRoot, When planned, Then identity.dataRoot follows that root", async () => {
    await withRoot(async (appRoot, dataRoot) => {
      // Given: isolated PathsService whose durable root is not the process preload default.
      const paths = testPaths({ platform: "linux", home: appRoot, env: {}, userDataRoot: dataRoot });
      expect(paths.roots.userDataRoot).toBe(dataRoot);

      // When
      const plan = await Effect.runPromise(
        Effect.flatMap(AppPlanner, (planner) =>
          planner.plan(literalTestLandofile(document, appRoot), TestRuntimeProvider.capabilities),
        ).pipe(
          Effect.provide(
            AppPlannerLayer.layer.pipe(
              Layer.provide(
                Layer.mergeAll(
                  PluginRegistryLayer.layer,
                  BunFileSystem.layer,
                  pathsServiceLayer({
                    platform: "linux",
                    home: appRoot,
                    env: {},
                    userDataRoot: dataRoot,
                  }),
                ),
              ),
            ),
          ),
        ),
      );

      // Then: planner stamps the provided durable root onto plan identity.
      expect(plan.identity?.dataRoot).toBe(AbsolutePath.make(await realpath(dataRoot)));
      expect(plan.identity?.dataRoot).not.toBe(testPaths().roots.userDataRoot);
    });
  });

  test("Given two PathsService data roots, When planned, Then each mutation yields its own identity.dataRoot", async () => {
    await withRoot(async (appRoot, firstData) => {
      const secondData = join(
        await realpath(await mkdtemp(join(tmpdir(), "lando-planner-paths-b-"))),
        "data",
      );
      await mkdir(secondData, { recursive: true });
      try {
        const planFor = (userDataRoot: string) =>
          Effect.runPromise(
            Effect.flatMap(AppPlanner, (planner) =>
              planner.plan(literalTestLandofile(document, appRoot), TestRuntimeProvider.capabilities),
            ).pipe(
              Effect.provide(
                AppPlannerLayer.layer.pipe(
                  Layer.provide(
                    Layer.mergeAll(
                      PluginRegistryLayer.layer,
                      BunFileSystem.layer,
                      pathsServiceLayer({
                        platform: "linux",
                        home: appRoot,
                        env: {},
                        userDataRoot,
                      }),
                    ),
                  ),
                ),
              ),
            ),
          );

        // When: the same app is planned under two durable roots.
        const first = await planFor(firstData);
        const second = await planFor(secondData);

        // Then: identity.dataRoot mutates with the injected PathsService root.
        expect(first.identity?.dataRoot).toBe(AbsolutePath.make(await realpath(firstData)));
        expect(second.identity?.dataRoot).toBe(AbsolutePath.make(await realpath(secondData)));
        expect(first.identity?.dataRoot).not.toBe(second.identity?.dataRoot);
      } finally {
        await rm(join(secondData, ".."), { recursive: true, force: true });
      }
    });
  });
});
