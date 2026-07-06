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
import { emptyConfigServiceLayer } from "../../../core/test/cli/agent-env-test-config.ts";
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
  copyOnWriteAppRoot: false,
  volumeSnapshot: "none",
  serviceFileCopy: "none",
  artifactExport: false,
  artifactImport: false,
  ephemeralMounts: false,
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
  return Layer.mergeAll(
    landofileLayer,
    plannerLayer,
    registryLayer,
    ProviderExecToolingEngineLive,
    emptyConfigServiceLayer,
  );
};

describe("memcached service type — scenario: Memcached + lando memcached-tool tooling", () => {
  test("AppPlanner produces a memcached plan with TCP endpoint and no persistent storage", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { cache: { type: "memcached" } },
    });

    const appPlan = await planLandofile(landofile);
    const cache = appPlan.services[ServiceName.make("cache")];
    if (cache === undefined) throw new Error("cache service missing from memcached plan");

    expect(cache.type).toBe("memcached");
    expect(cache.artifact).toEqual({ kind: "ref", ref: "memcached:1.6" });
    expect(cache.endpoints).toEqual([{ port: 11211, protocol: "tcp", name: "cache" }]);
    expect(cache.storage).toEqual([]);
    expect(cache.healthcheck?.kind).toBe("command");
    expect(cache.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/11211"]);
    expect(cache.environment.LANDO_SERVICE_TYPE).toBe("memcached");
  });

  test("`lando memcached-tool stats` tooling alias routes through provider.exec to the cache service", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { cache: { type: "memcached" } },
      tooling: {
        "memcached-tool": {
          service: "cache",
          cmd: ["sh", "-c", 'printf "%s\\r\\n" "$*" | nc -q 1 127.0.0.1 11211', "memcached-tool"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const statsOutput =
      "STAT pid 1\r\nSTAT uptime 42\r\nSTAT curr_items 1\r\nSTAT cmd_set 1\r\nSTAT cmd_get 1\r\nEND\r\n";
    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: statsOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "memcached-tool", args: ["stats"] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("memcached-tool");
    expect(result.service).toBe("cache");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(statsOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("cache");
    expect(calls[0]?.command).toEqual([
      "sh",
      "-c",
      'printf "%s\\r\\n" "$*" | nc -q 1 127.0.0.1 11211',
      "memcached-tool",
      "stats",
    ]);
  });

  test("set + get key sequence via tooling alias routes both commands through provider.exec", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { cache: { type: "memcached" } },
      tooling: {
        "memcached-tool": {
          service: "cache",
          cmd: ["sh", "-c", 'printf "%s\\r\\n" "$*" | nc -q 1 127.0.0.1 11211', "memcached-tool"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([
      { exitCode: 0, stdout: "STORED\r\n" },
      { exitCode: 0, stdout: "VALUE foo 0 3\r\nbar\r\nEND\r\n" },
    ]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const setResult = await Effect.runPromise(
      runTooling({ name: "memcached-tool", args: ["set foo 0 0 3\r\nbar"] }).pipe(Effect.provide(layer)),
    );
    expect(setResult.exitCode).toBe(0);
    expect(setResult.stdout).toBe("STORED\r\n");

    const getResult = await Effect.runPromise(
      runTooling({ name: "memcached-tool", args: ["get foo"] }).pipe(Effect.provide(layer)),
    );
    expect(getResult.exitCode).toBe(0);
    expect(getResult.stdout).toContain("bar");

    expect(calls).toHaveLength(2);
    expect(calls[0]?.service).toBe("cache");
    expect(calls[1]?.service).toBe("cache");
  });
});
