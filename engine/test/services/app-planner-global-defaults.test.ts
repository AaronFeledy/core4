import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Layer, Schema } from "effect";

import { rememberLandofileAppRoot } from "@lando/landofile/app-root-provenance";
import { makeLandoPaths } from "@lando/paths";
import { GlobalConfig, LandofileShape, ServiceName } from "@lando/sdk/schema";
import { AppPlanner, ConfigService, PathsService } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { PluginRegistryLive } from "../../src/plugins/registry.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";

const configLayer = (config: GlobalConfig) => {
  const load = Effect.succeed(config);
  return Layer.succeed(ConfigService, {
    load,
    get: <K extends keyof GlobalConfig>(key: K) => Effect.map(load, (loaded): GlobalConfig[K] => loaded[key]),
  });
};

const plan = (input: {
  readonly appRoot: string;
  readonly config: GlobalConfig;
  readonly landofile: LandofileShape;
  readonly paths: ReturnType<typeof makeLandoPaths>;
}) => {
  const dependencies = Layer.mergeAll(
    PluginRegistryLive,
    configLayer(input.config),
    Layer.succeed(PathsService, input.paths),
  );
  const planner = AppPlannerLive.pipe(Layer.provide(dependencies));
  return Effect.runPromise(
    Effect.flatMap(AppPlanner, (service) =>
      service.plan(
        rememberLandofileAppRoot(input.landofile, input.appRoot),
        TestRuntimeProvider.capabilities,
      ),
    ).pipe(Effect.provide(planner)),
  );
};

const composeLandofile = (
  name: string,
  environment?: Record<string, string>,
  labels?: Record<string, string>,
) =>
  Schema.decodeUnknownSync(LandofileShape)({
    name,
    runtime: 4,
    services: {
      app: {
        type: "compose",
        image: "busybox:latest",
        appMount: false,
        home: false,
        ...(environment === undefined ? {} : { environment }),
        ...(labels === undefined ? {} : { labels }),
      },
    },
  });

test("global app defaults apply below user-app service-authored environment and labels", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-global-app-defaults-"));
  const paths = makeLandoPaths({
    platform: "linux",
    home: root,
    env: {},
    userCacheRoot: join(root, "cache"),
    userDataRoot: join(root, "data"),
    userConfRoot: join(root, "config"),
  });
  const appRoot = join(root, "app");

  try {
    await mkdir(appRoot, { recursive: true });
    const result = await plan({
      appRoot,
      paths,
      config: Schema.decodeUnknownSync(GlobalConfig)({
        appEnv: { DEFAULT_ONLY: "global", SHARED: "global" },
        appLabels: { "com.example.default": "global", "com.example.shared": "global" },
      }),
      landofile: composeLandofile("user-app", { SHARED: "service" }, { "com.example.shared": "service" }),
    });
    const service = result.services[ServiceName.make("app")];

    expect(service?.environment).toMatchObject({ DEFAULT_ONLY: "global", SHARED: "service" });
    expect(service?.extensions.compose).toMatchObject({
      labels: {
        "com.example.default": "global",
        "com.example.shared": "service",
      },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test.each(["global", "scratch"] as const)("global app defaults do not apply to %s apps", async (kind) => {
  const root = await mkdtemp(join(tmpdir(), `lando-${kind}-defaults-`));
  const paths = makeLandoPaths({
    platform: "linux",
    home: root,
    env: {},
    userCacheRoot: join(root, "cache"),
    userDataRoot: join(root, "data"),
    userConfRoot: join(root, "config"),
  });
  const appRoot = kind === "global" ? paths.globalAppRoot : join(paths.scratchDir, "scratch-example");

  try {
    await mkdir(appRoot, { recursive: true });
    const result = await plan({
      appRoot,
      paths,
      config: Schema.decodeUnknownSync(GlobalConfig)({
        appEnv: { DEFAULT_ONLY: "global" },
        appLabels: { "com.example.default": "global" },
      }),
      landofile: composeLandofile(kind === "global" ? "global" : "scratch-example"),
    });
    const service = result.services[ServiceName.make("app")];

    expect(service?.environment.DEFAULT_ONLY).toBeUndefined();
    expect(service?.extensions.compose).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
