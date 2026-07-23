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

describe("compose passthrough — scenario: third-party image with default endpoint and app-root mount", () => {
  test("AppPlanner accepts a third-party image not in the canonical catalog and emits a default endpoint", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        whoami: {
          type: "compose",
          image: "traefik/whoami:v1.10",
          ports: ["8080:80"],
        },
      },
    });

    const appPlan = await planLandofile(landofile);
    const whoami = appPlan.services[ServiceName.make("whoami")];
    if (whoami === undefined) throw new Error("whoami service missing from compose passthrough plan");

    expect(whoami.type).toBe("compose");
    expect(whoami.artifact).toEqual({ kind: "ref", ref: "traefik/whoami:v1.10" });
    expect(whoami.endpoints).toEqual([
      {
        _tag: "published",
        port: 80,
        protocol: "tcp",
        name: "whoami",
        publication: { hostPort: 8080 },
      },
    ]);

    // compose is an l337 service and must not inject the LANDO_* env layer.
    expect(Object.keys(whoami.environment).filter((k) => k === "LANDO" || k.startsWith("LANDO_"))).toEqual(
      [],
    );

    expect(whoami.appMount).toMatchObject({ target: "/app", readOnly: false });
    expect(whoami.mounts.some((m) => m.type === "bind" && String(m.target) === "/app")).toBe(true);

    expect(appPlan.networks).toEqual([{ name: "lando-myapp", shared: false, driver: "bridge" }]);
  });

  test("`lando whoami-probe` tooling alias routes a curl against the third-party service via provider.exec", async () => {
    const body = "Hostname: whoami\nIP: 172.20.0.2\nUser-Agent: lando-curl\n";
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        whoami: {
          type: "compose",
          image: "traefik/whoami:v1.10",
          ports: ["8080:80"],
        },
      },
      tooling: {
        "whoami-probe": {
          service: "whoami",
          cmd: ["sh", "-c", "curl -sf http://localhost:80/", "whoami-probe"],
        },
      },
    });
    const appPlan = await planLandofile(landofile);

    const { provider, calls } = makeProvider([{ exitCode: 0, stdout: body }]);
    const layer = makeToolingLayer({ landofile, plan: appPlan, provider });

    const result = await Effect.runPromise(
      runTooling({ name: "whoami-probe", args: [] }).pipe(Effect.provide(layer)),
    );

    expect(result.tool).toBe("whoami-probe");
    expect(result.service).toBe("whoami");
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Hostname: whoami");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.service).toBe("whoami");
  });

  test("third-party image with appMount: false skips the app-root bind and the LANDO_APP_ROOT env", async () => {
    const landofile = Schema.decodeUnknownSync(LandofileShape)({
      name: "myapp",
      services: {
        sidekick: {
          type: "compose",
          image: "traefik/whoami:v1.10",
          appMount: false,
          ports: ["9090:80"],
        },
      },
    });

    const appPlan = await planLandofile(landofile);
    const sidekick = appPlan.services[ServiceName.make("sidekick")];
    if (sidekick === undefined) throw new Error("sidekick service missing from compose passthrough plan");

    expect(sidekick.appMount).toBeUndefined();
    expect(sidekick.mounts).toEqual([]);
    expect(Object.keys(sidekick.environment).filter((k) => k === "LANDO" || k.startsWith("LANDO_"))).toEqual(
      [],
    );
    expect(sidekick.endpoints).toEqual([
      {
        _tag: "published",
        port: 80,
        protocol: "tcp",
        name: "sidekick",
        publication: { hostPort: 9090 },
      },
    ]);
    expect(appPlan.networks).toEqual([{ name: "lando-myapp", shared: false, driver: "bridge" }]);
  });
});
