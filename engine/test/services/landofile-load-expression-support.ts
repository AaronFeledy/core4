import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Cause, Effect, Exit, Layer, Option, Schema } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { GlobalConfig } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, LandofileService, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import * as AppCacheService from "../../src/cache/service";
import * as PluginRegistryLayer from "../../src/plugins/registry";
import * as BunFileSystem from "../../src/services/file-system";
import * as AppPlannerLayer from "../../src/services/planner";
import * as TestLandofileServiceLayer from "./landofile-layer.ts";

export const PEM = "-----BEGIN CERTIFICATE-----\ncorp\n-----END CERTIFICATE-----\n";
export const IMPORTED_PEM = "-----BEGIN CERTIFICATE-----\nimported\n-----END CERTIFICATE-----\n";

export const withApp = async <A>(run: (appRoot: string) => Promise<A>): Promise<A> => {
  const appRoot = await mkdtemp(join(tmpdir(), "lando-load-expression-"));
  const cwd = process.cwd();
  try {
    process.chdir(appRoot);
    return await run(appRoot);
  } finally {
    process.chdir(cwd);
    await rm(appRoot, { recursive: true, force: true });
  }
};

const discoverEffect = Effect.flatMap(LandofileService, (service) => service.discover).pipe(
  Effect.provide(TestLandofileServiceLayer.layer),
);

export const discover = () => Effect.runPromise(discoverEffect);

export const discoverFailure = async () => {
  const exit = await Effect.runPromiseExit(discoverEffect);
  if (Exit.isSuccess(exit)) throw new Error("expected discovery failure");
  return Option.getOrThrow(Cause.findErrorOption(exit.cause));
};

export const planDiscoveredEffect = (input: { readonly appRoot: string; readonly cacheRoot: string }) => {
  const config = Schema.decodeUnknownSync(GlobalConfig)({ userCacheRoot: input.cacheRoot });
  const dependencies = Layer.mergeAll(
    TestLandofileServiceLayer.layer,
    AppCacheService.layer,
    PluginRegistryLayer.layer,
    BunFileSystem.layer,
    Layer.succeed(
      ConfigService,
      ConfigService.of({
        load: Effect.succeed(config),
        get: <K extends keyof GlobalConfig>(key: K) => Effect.succeed(config[key]),
      }),
    ),
    Layer.succeed(
      PathsService,
      makeLandoPaths({
        platform: "linux",
        home: input.appRoot,
        env: {},
        userCacheRoot: input.cacheRoot,
      }),
    ),
  );
  const planner = AppPlannerLayer.layer.pipe(Layer.provide(dependencies));
  return Effect.gen(function* () {
    const landofileService = yield* LandofileService;
    const appPlanner = yield* AppPlanner;
    const landofile = yield* landofileService.discover;
    return yield* appPlanner.plan(landofile, TestRuntimeProvider.capabilities);
  }).pipe(Effect.provide(Layer.merge(dependencies, planner)));
};

export const planDiscovered = (input: { readonly appRoot: string; readonly cacheRoot: string }) =>
  Effect.runPromise(planDiscoveredEffect(input));
