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
  serviceLogSources: true,
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

describe("opensearch service type — scenario: OpenSearch + lando os-cli tooling", () => {
  test("AppPlanner produces an opensearch plan with HTTP endpoint, persistent storage, and command healthcheck", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "opensearch" } },
    });

    const appPlan = await planLandofile(landofile);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing from opensearch plan");

    expect(search.type).toBe("opensearch");
    expect(search.artifact).toEqual({
      kind: "ref",
      ref: "opensearchproject/opensearch:2",
    });
    expect(search.endpoints).toEqual([{ _tag: "internal", port: 9200, protocol: "http", name: "search" }]);
    expect(search.storage).toHaveLength(1);
    expect(search.storage[0]?.store).toBe("myapp-opensearch-data");
    expect(search.healthcheck?.kind).toBe("command");
    expect(search.healthcheck?.command).toEqual([
      "bash",
      "-c",
      "curl -sf http://localhost:9200/_cluster/health",
    ]);
    expect(search.environment.LANDO_SERVICE_TYPE).toBe("opensearch");
    expect(search.environment["discovery.type"]).toBe("single-node");
    expect(search.environment.DISABLE_SECURITY_PLUGIN).toBe("true");
    expect(search.environment["http.port"]).toBe("9200");
  });

  test("`lando os-cli /_cluster/health` tooling alias routes through provider.exec to the search service", async () => {
    const healthOutput = '{"status":"green","number_of_nodes":1}\n';
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "opensearch" } },
      tooling: {
        "os-cli": {
          service: "search",
          cmd: ["sh", "-c", 'path=${1:-/}; curl -sf -- "http://localhost:9200${path}"', "os-cli"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: healthOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "os-cli", args: ["/_cluster/health"] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("os-cli");
    expect(result.service).toBe("search");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(healthOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("search");
    expect(calls[0]?.command).toEqual([
      "sh",
      "-c",
      'path=${1:-/}; curl -sf -- "http://localhost:9200${path}"',
      "os-cli",
      "/_cluster/health",
    ]);
  });

  test("`lando os-cli /_cat/indices` routes through provider.exec and returns index listing", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "opensearch" } },
      tooling: {
        "os-cli": {
          service: "search",
          cmd: ["sh", "-c", 'path=${1:-/}; curl -sf -- "http://localhost:9200${path}"', "os-cli"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const catOutput = "green open my-index abc123 1 0 0 0 230b 230b\n";
    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: catOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "os-cli", args: ["/_cat/indices"] }).pipe(Effect.provide(layer)),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(catOutput);
    expect(calls[0]?.command).toEqual([
      "sh",
      "-c",
      'path=${1:-/}; curl -sf -- "http://localhost:9200${path}"',
      "os-cli",
      "/_cat/indices",
    ]);
  });
});
