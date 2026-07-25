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
  readonly env?: Readonly<Record<string, string>>;
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
      calls.push({
        service: String(target.service),
        command: spec.command,
        ...(spec.env === undefined ? {} : { env: spec.env }),
      });
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

describe("go service type — scenario: minimal HTTP server + lando go version tooling", () => {
  test("AppPlanner produces a go:1.22 plan exposing an HTTP endpoint and bind-mounted source", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "go:1.22" } },
    });

    const appPlan = await planLandofile(landofile);
    const web = appPlan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing from go plan");

    expect(web.type).toBe("go:1.22");
    expect(web.endpoints).toEqual([{ _tag: "internal", port: 8080, protocol: "http", name: "web" }]);
    expect(web.healthcheck?.kind).toBe("command");
    expect(web.healthcheck?.command).toEqual(["bash", "-c", "exec 3<>/dev/tcp/127.0.0.1/8080"]);
    expect(String(web.workingDirectory)).toBe("/app");
    expect(web.mounts[0]?.type).toBe("bind");
    expect(String(web.mounts[0]?.target)).toBe("/app");
    expect(web.environment.LANDO_SERVICE_TYPE).toBe("go:1.22");
    expect(web.environment.LANDO_APP_ROOT).toBe("/app");
    expect(web.environment.GOPATH).toBe("/go");
    expect(web.environment.CGO_ENABLED).toBe("0");
  });

  test("AppPlanner exposes the go web service as primary so lando go ... resolves to it without service: in tooling", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "go:1.22" } },
    });
    const appPlan = await planLandofile(landofile);
    const web = appPlan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing");
    expect(web.primary).toBe(true);
  });

  test("`lando go version` tooling alias routes through provider.exec to the go service", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "go:1.22" } },
      tooling: { go: { service: "web", cmd: "go" } },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "go version go1.22.0 linux/amd64\n" }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "go", args: ["version"] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("go");
    expect(result.service).toBe("web");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("go version go1.22.0 linux/amd64\n");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("web");
    expect(calls[0]?.command).toEqual(["sh", "-c", "go version"]);
  });

  test("`lando go build ./...` passes through args while keeping the go service target", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "go:1.23" } },
      tooling: { go: { service: "web", cmd: ["go"] } },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "" }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "go", args: ["build", "./..."] }).pipe(Effect.provide(layer)),
    );

    expect(result.exitCode).toBe(0);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("web");
    expect(calls[0]?.command).toEqual(["go", "build", "./..."]);
  });

  test("resolved app targets re-read agentEnv instead of using a cached Landofile snapshot", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      agentEnv: false,
      services: { web: { type: "go:1.22" } },
      tooling: { go: { service: "web", cmd: "go" } },
    });
    const staleLandofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "go:1.22" } },
      tooling: { go: { service: "web", cmd: "go" } },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: "go version go1.22.0 linux/amd64\n" }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });
    const saved = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    try {
      const result = await Effect.runPromise(
        runTooling(
          { name: "go", args: ["version"] },
          {
            plan: appPlan,
            root: process.cwd(),
            app: { kind: "user", id: appPlan.id, root: appPlan.root },
            landofile: staleLandofile,
          },
        ).pipe(Effect.provide(layer)),
      );

      expect(result.exitCode).toBe(0);
    } finally {
      process.env.CLAUDECODE = saved;
    }

    expect(calls[0]?.env).toBeUndefined();
  });
});
