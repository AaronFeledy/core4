import { describe, expect, test } from "bun:test";
import { Effect, Layer } from "effect";

import { AppPlanner } from "@lando/core/services";
import { type LandofileShape, ProviderId, ServiceName } from "@lando/sdk/schema";

import { PluginRegistryLive } from "../../../core/src/plugins/registry.ts";
import { AppPlannerLive } from "../../../core/src/services/planner.ts";
import { renderCompose as renderDockerCompose } from "../../provider-docker/src/index.ts";
import { renderCompose as renderLandoCompose } from "../../provider-lando/src/compose.ts";
import { services } from "../src/index.ts";

const providerLandoCapabilities = {
  artifactBuild: true,
  artifactPull: true,
  buildSecrets: true,
  buildSsh: true,
  multiServiceApply: true,
  serviceExec: true,
  serviceLogs: true,
  serviceHealth: "native",
  hostReachability: "native",
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
  hostPortPublish: "native",
  routeProvider: true,
  tlsCertificates: "lando",
  rootless: true,
  privilegedServices: false,
  composeSpec: "native",
  providerExtensions: ["compose", "labels", "registryCredentials"],
} as const;

const registryLayer = Layer.merge(services, PluginRegistryLive);

const planFor = (landofile: LandofileShape, provider: "lando" | "docker") =>
  Effect.runPromise(
    Effect.flatMap(AppPlanner, (planner) =>
      planner.plan({ ...landofile, provider: ProviderId.make(provider) }, providerLandoCapabilities),
    ).pipe(Effect.provide(AppPlannerLive), Effect.provide(registryLayer)),
  );

const composeLandofile: LandofileShape = {
  name: "composeapp",
  runtime: 4,
  services: {
    [ServiceName.make("worker")]: {
      type: "compose",
      image: "ghcr.io/example/worker:latest",
      ports: ["9000:9000"],
      volumes: ["worker-state:/var/state"],
      environment: { WORKER_ENV: "prod" },
      providers: {
        lando: { labels: { "com.example.team": "platform" } },
        docker: { restart: "unless-stopped" },
      },
    },
  },
};

describe("compose passthrough through provider-lando and provider-docker", () => {
  test("provider-lando renderCompose emits the compose image, named volume, env, and port mapping", async () => {
    const plan = await planFor(composeLandofile, "lando");

    expect(plan.stores.map((s) => s.name)).toContain("composeapp-worker-state");
    expect(plan.stores.every((s) => s.scope === "service")).toBe(true);

    const document = renderLandoCompose(plan);
    expect(document).toContain('image: "ghcr.io/example/worker:latest"');
    expect(document).toContain('"9000:9000"');
    expect(document).toContain('- "composeapp-worker-state:/var/state"');
    expect(document).toContain('WORKER_ENV: "prod"');
    expect(document).toContain("volumes:");
    expect(document).toContain("composeapp-worker-state:");
  });

  test("provider-docker renderCompose emits the compose image and port mapping from a compose-typed plan", async () => {
    const plan = await planFor(composeLandofile, "docker");

    expect(plan.stores.map((s) => s.name)).toContain("composeapp-worker-state");

    const document = renderDockerCompose(plan);
    expect(document).toContain("ghcr.io/example/worker:latest");
    expect(document).toContain("9000:9000");
  });

  test("compose-declared named volumes follow destroy-preserves-volumes for both providers", async () => {
    const landoPlan = await planFor(composeLandofile, "lando");
    const dockerPlan = await planFor(composeLandofile, "docker");
    expect(landoPlan.stores).toContainEqual({ name: "composeapp-worker-state", scope: "service" });
    expect(dockerPlan.stores).toContainEqual({ name: "composeapp-worker-state", scope: "service" });
  });

  test("provider extensions in service.providers.<id> flow through to ServicePlan.extensions", async () => {
    const plan = await planFor(composeLandofile, "lando");
    const worker = plan.services[ServiceName.make("worker")];
    expect(worker?.extensions).toEqual({
      lando: { labels: { "com.example.team": "platform" } },
      docker: { restart: "unless-stopped" },
    });
  });

  test("default compose plan emits app-root bind mount and per-app network membership", async () => {
    const plan = await planFor(composeLandofile, "lando");
    const worker = plan.services[ServiceName.make("worker")];

    expect(worker?.appMount).toMatchObject({ target: "/app", readOnly: false });
    expect(worker?.mounts.some((m) => m.type === "bind" && String(m.target) === "/app")).toBe(true);
    // compose is an l337 service and must not inject the LANDO_* env layer.
    expect(
      Object.keys(worker?.environment ?? {}).filter((k) => k === "LANDO" || k.startsWith("LANDO_")),
    ).toEqual([]);

    expect(plan.networks).toEqual([{ name: "lando-composeapp", shared: false, driver: "bridge" }]);
  });

  test("appMount: false opts out — no appMount, no synthetic /app bind", async () => {
    const optedOut: LandofileShape = {
      ...composeLandofile,
      services: {
        [ServiceName.make("worker")]: {
          type: "compose",
          image: "ghcr.io/example/worker:latest",
          appMount: false,
          ports: ["9000:9000"],
        },
      },
    };
    const plan = await planFor(optedOut, "lando");
    const worker = plan.services[ServiceName.make("worker")];

    expect(worker?.appMount).toBeUndefined();
    expect(worker?.mounts).toEqual([]);
    expect(worker?.environment.LANDO_APP_ROOT).toBeUndefined();
    expect(worker?.environment.LANDO_PROJECT_MOUNT).toBeUndefined();

    expect(plan.networks).toEqual([{ name: "lando-composeapp", shared: false, driver: "bridge" }]);
  });
});
