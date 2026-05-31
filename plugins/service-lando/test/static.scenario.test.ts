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
  copyOnWriteAppRoot: false,
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

describe("static service type — scenario: nginx-backed dist/ serve + lando curl tooling", () => {
  test("AppPlanner produces a static plan with HTTP endpoint and read-only app mount", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static" } },
    });

    const appPlan = await planLandofile(landofile);
    const web = appPlan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing from static plan");

    expect(web.type).toBe("static:nginx");
    expect(web.artifact).toEqual({ kind: "ref", ref: "nginx:1.26-alpine" });
    expect(web.endpoints).toEqual([{ port: 80, protocol: "http", name: "web" }]);
    expect(web.appMount?.readOnly).toBe(true);
    expect(web.healthcheck?.kind).toBe("command");
    expect(web.healthcheck?.command).toEqual(["sh", "-c", "nc -z 127.0.0.1 80"]);
    expect(web.environment.LANDO_SERVICE_TYPE).toBe("static:nginx");
    expect(web.environment.LANDO_WEBROOT).toBe("/app");
  });

  test("AppPlanner with root: dist sets LANDO_WEBROOT to /app/dist", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static", root: "dist" } },
    });

    const appPlan = await planLandofile(landofile);
    const web = appPlan.services[ServiceName.make("web")];
    if (web === undefined) throw new Error("web service missing from static plan");

    expect(web.type).toBe("static:nginx");
    expect(web.environment.LANDO_WEBROOT).toBe("/app/dist");
    expect(web.appMount?.readOnly).toBe(true);
    expect(web.endpoints).toEqual([{ port: 80, protocol: "http", name: "web" }]);
  });

  test("`lando curl` tooling alias fetches a known file from the static service via provider.exec", async () => {
    const fileBody = "<!doctype html><html><body>hello</body></html>\n";
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: { web: { type: "static", root: "dist" } },
      tooling: {
        curl: {
          service: "web",
          cmd: ["sh", "-c", 'curl -sf "http://localhost:80/$1"', "curl"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: fileBody }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "curl", args: ["index.html"] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("curl");
    expect(result.service).toBe("web");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe(fileBody);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("web");
    expect(calls[0]?.command).toEqual([
      "sh",
      "-c",
      'curl -sf "http://localhost:80/$1"',
      "curl",
      "index.html",
    ]);
  });
});
