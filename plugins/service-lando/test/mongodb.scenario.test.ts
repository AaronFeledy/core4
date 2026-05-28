import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";

import { runTooling } from "@lando/core/cli/operations";
import { ProviderUnavailableError } from "@lando/core/errors";
import {
  type AppPlan,
  LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/core/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/core/services";

import { PluginRegistryLive } from "../../../core/src/plugins/registry.ts";
import { AppPlannerLive } from "../../../core/src/services/planner.ts";
import { ProviderExecToolingEngineLive } from "../../../core/src/services/tooling-engine.ts";
import { services } from "../src/index.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "lando",
  hostReachability: "emulated",
  sharedCrossAppNetwork: true,
  persistentStorage: true,
  bindMounts: true,
  bindMountPerformance: "native",
  copyMounts: true,
  hostPortPublish: "proxy",
  routeProvider: false,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "portable",
  providerExtensions: [],
};

interface ExecCall {
  readonly service: string;
  readonly command: ReadonlyArray<string>;
}

const makeProvider = (
  responses: ReadonlyArray<{ exitCode: number; stdout?: string; stderr?: string }>,
): { provider: RuntimeProviderShape; calls: ExecCall[] } => {
  const calls: ExecCall[] = [];
  let i = 0;
  const provider: RuntimeProviderShape = {
    id: providerId,
    displayName: "Fake Lando",
    version: "0.0.0",
    platform: "linux",
    capabilities,
    isAvailable: Effect.succeed(true),
    setup: () => Effect.void,
    getStatus: Effect.succeed({ running: true }),
    getVersions: Effect.succeed({ provider: "0.0.0" }),
    buildArtifact: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "buildArtifact", message: "n/a" })),
    pullArtifact: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "pullArtifact", message: "n/a" })),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    destroy: () => Effect.void,
    exec: (target, spec) => {
      calls.push({ service: String(target.service), command: spec.command });
      const response = responses[i] ?? { exitCode: 0 };
      i += 1;
      return Effect.succeed({
        exitCode: response.exitCode,
        stdout: response.stdout ?? "",
        stderr: response.stderr ?? "",
      });
    },
    execStream: () => Stream.empty,
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.empty,
    inspect: () =>
      Effect.fail(new ProviderUnavailableError({ providerId, operation: "inspect", message: "n/a" })),
    list: () => Effect.succeed([]),
  };
  return { provider, calls };
};

const planLandofile = (landofile: LandofileShape): Promise<AppPlan> =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
      Effect.provide(Layer.merge(services, AppPlannerLive)),
      Effect.provide(PluginRegistryLive),
    ),
  );

const makeToolingLayer = (options: {
  readonly landofile: LandofileShape;
  readonly plan: AppPlan;
  readonly provider: RuntimeProviderShape;
}) => {
  const landofileLayer = Layer.succeed(LandofileService, {
    discover: Effect.succeed(options.landofile),
  });
  const plannerLayer = Layer.succeed(AppPlanner, {
    plan: () => Effect.succeed(options.plan),
  });
  const registryLayer = Layer.succeed(RuntimeProviderRegistry, {
    list: Effect.succeed([providerId]),
    capabilities: Effect.succeed(capabilities),
    select: () => Effect.succeed(options.provider),
  });
  return Layer.mergeAll(landofileLayer, plannerLayer, registryLayer, ProviderExecToolingEngineLive);
};

describe("mongodb service type — scenario: MongoDB + lando mongosh tooling", () => {
  test("AppPlanner produces a mongodb plan with TCP endpoint and persistent storage", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
    });

    const appPlan = await planLandofile(landofile);
    const db = appPlan.services[ServiceName.make("db")];
    if (db === undefined) throw new Error("db service missing from mongodb plan");

    expect(db.type).toBe("mongodb");
    expect(db.artifact).toEqual({ kind: "ref", ref: "mongo:7" });
    expect(db.endpoints).toEqual([{ port: 27017, protocol: "tcp", name: "db" }]);
    expect(db.storage).toHaveLength(1);
    expect(db.storage[0]?.store).toBe("myapp-mongodb-data");
    expect(String(db.storage[0]?.target)).toBe("/data/db");
    expect(db.healthcheck?.kind).toBe("command");
    expect(db.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/27017"]);
    expect(db.environment.LANDO_SERVICE_TYPE).toBe("mongodb");
    expect(db.environment.MONGO_INITDB_ROOT_USERNAME).toBe("lando");
    expect(db.environment.MONGO_INITDB_ROOT_PASSWORD).toBe("lando");
    expect(db.environment.MONGO_INITDB_DATABASE).toBe("myapp");
  });

  test("`lando mongosh` tooling alias routes through provider.exec to the mongodb service", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
      tooling: { mongosh: { service: "db", cmd: ["mongosh"] } },
    });
    const appPlan = await planLandofile(landofile);

    const pingOutput = "{ ok: 1 }\n";
    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: pingOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "mongosh", args: ["--eval", "db.runCommand('ping')"] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("mongosh");
    expect(result.service).toBe("db");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(pingOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("db");
    expect(calls[0]?.command).toEqual(["mongosh", "--eval", "db.runCommand('ping')"]);
  });

  test("`lando mongosh` with extra args passes all arguments to the mongodb service", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb" } },
      tooling: { mongosh: { service: "db", cmd: ["mongosh"] } },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "" }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    await Effect.runPromise(
      runTooling({ name: "mongosh", args: ["--quiet", "--eval", "show dbs"] }).pipe(Effect.provide(layer)),
    );

    expect(calls[0]?.command).toEqual(["mongosh", "--quiet", "--eval", "show dbs"]);
  });
});
