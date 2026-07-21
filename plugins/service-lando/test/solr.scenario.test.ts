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
  AppPlanResolver,
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
    Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities, { kind: "user" })).pipe(
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
  const plannerLayer = Layer.succeed(AppPlanResolver, {
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

describe("solr service type — scenario: Solr + lando solr-admin tooling", () => {
  test("AppPlanner produces a solr plan with HTTP endpoint, persistent storage, and HTTP healthcheck", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr" } },
    });

    const appPlan = await planLandofile(landofile);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing from solr plan");

    expect(search.type).toBe("solr");
    expect(search.artifact).toEqual({ kind: "ref", ref: "solr:9" });
    expect(search.endpoints).toEqual([{ port: 8983, protocol: "http", name: "search" }]);
    expect(search.storage).toHaveLength(1);
    expect(search.storage[0]?.store).toBe("myapp-solr-data");
    expect(search.healthcheck?.kind).toBe("command");
    expect(search.healthcheck?.command).toEqual([
      "bash",
      "-c",
      "curl -sf http://localhost:8983/solr/admin/info/system",
    ]);
    expect(search.environment.LANDO_SERVICE_TYPE).toBe("solr");
  });

  test("AppPlanner with cores: produces a precreate-core command for the named core", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr", cores: ["gettingstarted"] } },
    });

    const appPlan = await planLandofile(landofile);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing");

    expect(Array.isArray(search.command)).toBe(true);
    const cmd = search.command as string[];
    expect(cmd[0]).toBe("bash");
    expect(cmd[1]).toBe("-c");
    expect(cmd[2]).toContain('precreate-core "$core"');
    expect(cmd[2]).toContain("solr-foreground");
    expect(cmd).toContain("gettingstarted");
  });

  test("`lando solr-admin status` tooling alias routes through provider.exec to the search service", async () => {
    const solrStatusOutput = "Solr is running on port 8983\n";
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr", cores: ["gettingstarted"] } },
      tooling: {
        "solr-admin": {
          service: "search",
          cmd: ["solr"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: solrStatusOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "solr-admin", args: ["status"] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("solr-admin");
    expect(result.service).toBe("search");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(solrStatusOutput);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("search");
    expect(calls[0]?.command).toEqual(["solr", "status"]);
    const search = appPlan.services[ServiceName.make("search")];
    if (search === undefined) throw new Error("search service missing");
    expect(search.command).toEqual([
      "bash",
      "-c",
      'port="$1"; shift; for core in "$@"; do precreate-core "$core"; done; exec solr-foreground -p "$port"',
      "lando-solr-precreate",
      "8983",
      "gettingstarted",
    ]);
  });

  test("`lando solr-admin healthcheck -c gettingstarted` routes through provider.exec", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { search: { type: "solr", cores: ["gettingstarted"] } },
      tooling: {
        "solr-admin": {
          service: "search",
          cmd: ["solr"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const healthOutput = '{"status":"OK","QTime":0}\n';
    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: healthOutput }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "solr-admin", args: ["healthcheck", "-c", "gettingstarted"] }).pipe(
        Effect.provide(layer),
      ),
    );

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(healthOutput);
    expect(calls[0]?.command).toEqual(["solr", "healthcheck", "-c", "gettingstarted"]);
  });
});
