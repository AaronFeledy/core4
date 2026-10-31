import { describe, expect, test } from "bun:test";
import { Effect, Layer, Schema, Stream } from "effect";
import { compileTestLandofile, toolingValueResolverLayer } from "./support/compiled-landofile.ts";

import { runTooling } from "@lando/engine/operations/tooling";
import * as PluginRegistryLayer from "@lando/engine/plugins/registry";
import * as LandoEventService from "@lando/engine/services/event-service";
import * as AppPlannerLayer from "@lando/engine/services/planner";
import * as ProviderExecToolingEngine from "@lando/engine/services/tooling-engine";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  type CurrentExecutableAppPlan,
  LandofileShape,
  type ProviderCapabilities,
  ProviderId,
  ServiceName,
} from "@lando/sdk/schema";
import {
  AppPlanner,
  LandofileService,
  RuntimeProviderRegistry,
  type RuntimeProviderShape,
} from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";

import { services } from "../src/index.ts";
import { emptyConfigServiceLayer } from "./support/agent-env-test-config.ts";
import { execStreamFromResponse } from "./support/exec-stream-from-response.ts";

const providerId = ProviderId.make("lando");

const capabilities: ProviderCapabilities = {
  artifactBuild: false,
  artifactPull: false,
  buildSecrets: false,
  buildSsh: false,
  multiServiceApply: true,
  serviceExec: true,
  serviceInit: true,
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
  architectureEmulation: false,
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
    ...TestRuntimeProvider,
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
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "buildArtifact",
          message: "n/a",
          remediation:
            "Install or start the selected runtime provider and confirm it can perform `buildArtifact`.",
        }),
      ),
    pullArtifact: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "pullArtifact",
          message: "n/a",
          remediation:
            "Install or start the selected runtime provider and confirm it can perform `pullArtifact`.",
        }),
      ),
    removeArtifact: () => Effect.void,
    apply: () => Effect.succeed({ changed: false }),
    start: () => Effect.void,
    stop: () => Effect.void,
    restart: () => Effect.void,
    waitForExit: () => Effect.succeed({ exitCode: 0 }),
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
    execStream: (target, spec) => {
      calls.push({ service: String(target.service), command: spec.command });
      const response = responses[i] ?? { exitCode: 0 };
      i += 1;
      return execStreamFromResponse(response);
    },
    run: () => Effect.succeed({ exitCode: 0, stdout: "", stderr: "" }),
    logs: () => Stream.empty,
    inspect: () =>
      Effect.fail(
        new ProviderUnavailableError({
          providerId,
          operation: "inspect",
          message: "n/a",
          remediation: "Install or start the selected runtime provider and confirm it can perform `inspect`.",
        }),
      ),
    list: () => Effect.succeed([]),
  };
  return { provider, calls };
};

const planLandofile = (landofile: LandofileShape): Promise<CurrentExecutableAppPlan> =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) => planner.plan(compileTestLandofile(landofile), capabilities)).pipe(
      Effect.provide(Layer.merge(services, AppPlannerLayer.layer)),
      Effect.provide(PluginRegistryLayer.layer),
    ),
  );

const makeToolingLayer = (options: {
  readonly landofile: LandofileShape;
  readonly plan: CurrentExecutableAppPlan;
  readonly provider: RuntimeProviderShape;
}) => {
  const landofileLayer = Layer.succeed(
    LandofileService,
    LandofileService.of({
      discover: Effect.sync(() => compileTestLandofile(options.landofile)),
    }),
  );
  const plannerLayer = Layer.succeed(
    AppPlanner,
    AppPlanner.of({
      plan: () => Effect.succeed(options.plan),
    }),
  );
  const registryLayer = Layer.succeed(
    RuntimeProviderRegistry,
    RuntimeProviderRegistry.of({
      resolveAppliedPlan: () => Effect.succeed(undefined),
      resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" as const }),
      appliedPlansFor: () => Effect.succeed([]),
      list: Effect.succeed([providerId]),
      capabilities: Effect.succeed(capabilities),
      select: () => Effect.succeed(options.provider),
    }),
  );
  return Layer.mergeAll(
    PrivateFileAccessService.layer,
    toolingValueResolverLayer,
    landofileLayer,
    plannerLayer,
    registryLayer,
    LandoEventService.layer,
    ProviderExecToolingEngine.layer.pipe(Layer.provide(toolingValueResolverLayer)),
    emptyConfigServiceLayer,
  );
};

describe("mongodb service type — scenario: MongoDB + lando mongosh tooling", () => {
  test("AppPlanner produces a mongodb plan with TCP endpoint and persistent storage", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { db: { type: "mongodb", home: false } },
    });

    const appPlan = await planLandofile(landofile);
    const db = appPlan.services[ServiceName.make("db")];
    if (db === undefined) throw new Error("db service missing from mongodb plan");

    expect(db.type).toBe("mongodb");
    expect(db.artifact).toEqual({ kind: "ref", ref: "mongo:7" });
    expect(db.endpoints).toEqual([
      { _tag: "internal", port: 27017, protocol: "tcp", name: "db", primary: true },
    ]);
    const volumes = db.mounts.filter((mount) => mount.type === "volume");
    expect(volumes).toHaveLength(1);
    expect(volumes[0]?.store).toBe("myapp-mongodb-data");
    expect(String(volumes[0]?.target)).toBe("/data/db");
    expect(db.healthcheck?.kind).toBe("command");
    expect(db.healthcheck?.target?.port).toBe(27017);
    expect(db.readiness?.target?.port).toBe(27017);
    expect(db.environment.HOME).toBeUndefined();
    expect(db.environment.LANDO_SERVICE_TYPE).toBe("mongodb");
    expect(db.environment.MONGO_INITDB_ROOT_USERNAME).toBe("lando");
    expect(db.environment.MONGO_INITDB_ROOT_PASSWORD).toBe("lando");
    expect(db.environment.MONGO_INITDB_DATABASE).toBe("myapp");
  });

  test.each([
    {
      healthcheck: { kind: "command", command: ["custom-mongo-check"], timeoutSeconds: 9 },
      expected: { kind: "command", command: ["custom-mongo-check"], timeoutSeconds: 9 },
    },
    { healthcheck: false, expected: { kind: "none" } },
  ])(
    "replaces native health without losing MongoDB protocol readiness: $healthcheck",
    async ({ healthcheck, expected }) => {
      // Given
      const landofile = Schema.decodeUnknownSync(LandofileShape)({
        name: "custom-probe",
        services: { db: { type: "mongodb", home: false, healthcheck } },
      });
      // When
      const plan = await planLandofile(landofile);
      // Then
      const service = plan.services[ServiceName.make("db")];
      expect(service?.healthcheck).toMatchObject(expected);
      expect(service?.readiness?.kind).toBe("command");
      expect(service?.readiness?.command).not.toEqual(service?.healthcheck?.command);
      expect(service?.readiness?.target?.port).toBe(27017);
      expect(service?.readinessSource).toBe("contributed");
    },
  );

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
      runTooling({
        name: "mongosh",
        input: { _tag: "RawArgv", argv: ["--eval", "db.runCommand('ping')"] },
      }).pipe(Effect.provide(layer)),
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
      runTooling({
        name: "mongosh",
        input: { _tag: "RawArgv", argv: ["--quiet", "--eval", "show dbs"] },
      }).pipe(Effect.provide(layer)),
    );

    expect(calls[0]?.command).toEqual(["mongosh", "--quiet", "--eval", "show dbs"]);
  });
});
