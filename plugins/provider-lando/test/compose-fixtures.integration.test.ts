import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Cause, Effect, Exit, Layer, Stream } from "effect";

import {
  bringDown,
  bringUp,
  introspectProviderCapabilities,
  makePodmanApiClient,
  providerLandoCapabilitiesForPlatform,
} from "@lando/provider-lando";
import { CapabilityError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";

import { makePluginRegistryLive } from "@lando/engine/plugins/registry";
import { loadLandofileFile } from "@lando/engine/services/landofile-live";
import { AppPlanner, AppPlannerLive } from "@lando/engine/services/planner";
import { assertServiceContainerRunning } from "./compose-fixture-container-state.ts";

const liveSocketPath = process.env.LANDO_TEST_PODMAN_SOCKET ?? "";
const fixturesRoot = resolve(import.meta.dir, "../../../core/test/fixtures/compose");
const plannerLayer = AppPlannerLive.pipe(Layer.provide(makePluginRegistryLive({ app: false, user: false })));

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const arrayField = (value: unknown, key: string): readonly unknown[] => {
  const candidate = field(value, key);
  return Array.isArray(candidate) ? candidate : [];
};

interface FixtureCase {
  readonly id: string;
  readonly file: string;
  readonly service: string;
  readonly assertInspect: (inspect: unknown, appRoot: string) => void;
}

const fixtures = [
  {
    id: "long-form-mounts-ports",
    file: "corpus/long-form-mounts-ports.compose.yaml",
    service: "web",
    assertInspect: (inspect: unknown, appRoot: string) => {
      const hostConfig = field(inspect, "HostConfig");
      expect(field(field(hostConfig, "PortBindings"), "8080/tcp")).toEqual([
        { HostIp: "127.0.0.1", HostPort: "8443" },
      ]);

      const mounts = arrayField(inspect, "Mounts");
      const bind = mounts.find(
        (mount) => (field(mount, "Destination") ?? field(mount, "Target")) === "/workspace/src",
      );
      const bindSource = join(appRoot, "src");
      const bindSpec = arrayField(hostConfig, "Binds").find(
        (candidate) => typeof candidate === "string" && candidate.startsWith(`${bindSource}:/workspace/src:`),
      );
      expect(bindSpec).toBeDefined();
      expect(bindSpec).toContain(":ro");
      expect(field(bind, "Source")).toBe(bindSource);
      expect(field(bind, "RW")).toBe(false);

      const volume = mounts.find((mount) => field(mount, "Destination") === "/var/cache/app");
      expect(field(volume, "Type")).toBe("volume");
      expect(field(volume, "RW")).toBe(true);

      const tmpfs = String(field(field(hostConfig, "Tmpfs"), "/run/app"));
      expect(tmpfs).toContain("size=67108864");
      expect(tmpfs).toContain("mode=1770");
    },
  },
  {
    id: "healthcheck",
    file: "corpus/healthcheck.compose.yaml",
    service: "gateway",
    assertInspect: (inspect: unknown) => {
      const healthcheck = field(field(inspect, "Config"), "Healthcheck");
      expect(field(healthcheck, "Test")).toEqual([
        "CMD-SHELL",
        "curl --fail http://localhost:8080/health || exit 1",
      ]);
      expect(field(healthcheck, "Interval")).toBe(30_000_000_000);
      expect(field(healthcheck, "Timeout")).toBe(30_000_000_000);
      expect(field(healthcheck, "Retries")).toBe(5);
      expect(field(healthcheck, "StartPeriod")).toBe(90_000_000_000);
    },
  },
  {
    id: "service-extensions",
    file: "corpus/service-extensions.compose.yaml",
    service: "worker",
    assertInspect: (inspect: unknown) => {
      const config = field(inspect, "Config");
      expect(field(config, "Image")).toBe("docker.io/library/node:22-alpine");
      expect(field(config, "Cmd")).toEqual(["node", "-e", "setInterval(() => {}, 1000)"]);
      expect(JSON.stringify(inspect)).not.toContain("x-lando-note");
      expect(JSON.stringify(inspect)).not.toContain("x-vendor");
    },
  },
] satisfies readonly FixtureCase[];

interface RejectedFixtureCase {
  readonly id: string;
  readonly file: string;
  readonly service: string;
  readonly key: "networks" | "configs" | "secrets" | "profiles";
}

const rejectedFixtures = [
  {
    id: "different-networks",
    file: "upstream/different_networks.compose.yaml",
    service: "entry",
    key: "networks",
  },
  {
    id: "simple-network",
    file: "upstream/simple_network.compose.yaml",
    service: "entry",
    key: "networks",
  },
  {
    id: "simple-configfile",
    file: "upstream/simple_configfile.compose.yaml",
    service: "entry",
    key: "configs",
  },
  {
    id: "simple-secretfile",
    file: "upstream/simple_secretfile.compose.yaml",
    service: "entry",
    key: "secrets",
  },
  {
    id: "service-profiles",
    file: "corpus/service-profiles.compose.yaml",
    service: "debugger",
    key: "profiles",
  },
] satisfies readonly RejectedFixtureCase[];

const makeRunnableLandofile = (name: string, fixture: string): string =>
  `name: ${name}\nprovider: lando\n${fixture.replace(
    /^(\s*)image:.*$/gmu,
    '$1type: compose\n$1image: node:22-alpine\n$1command: ["node", "-e", "setInterval(() => {}, 1000)"]',
  )}`;

const runFixture = async (fixture: FixtureCase): Promise<void> => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), `lando-compose-${fixture.id}-`)));
  const api = makePodmanApiClient(liveSocketPath);
  const liveRequest = api.request;
  if (liveRequest === undefined) throw new Error("live Podman client exposes no request transport");
  let plan: AppPlan | undefined;
  const initializerContainers = new Set<string>();

  try {
    await mkdir(join(appRoot, "src"));
    const fixtureSource = await Bun.file(join(fixturesRoot, fixture.file)).text();
    const landofilePath = join(appRoot, ".lando.yml");
    await writeFile(landofilePath, makeRunnableLandofile(`compose-fixture-${fixture.id}`, fixtureSource));

    const landofile = await Effect.runPromise(loadLandofileFile(landofilePath));
    const capabilities = await Effect.runPromise(introspectProviderCapabilities(api));
    plan = await Effect.runPromise(
      AppPlanner.pipe(
        Effect.flatMap((planner) => planner.plan(landofile, capabilities)),
        Effect.provide(plannerLayer),
      ),
    );

    for (const service of Object.values(plan.services)) {
      for (const storage of service.storage) {
        if (storage.subpath === undefined) continue;
        const store = plan.stores.find((candidate) => candidate.name === storage.store);
        expect(store, `planned store ${storage.store} is missing`).toBeDefined();
        if (store === undefined) continue;

        const volumeCreate = await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: "/volumes/create",
            body: {
              Name: store.name,
              Labels: {
                "dev.lando.app": plan.id,
                "dev.lando.provider": plan.provider,
                "dev.lando.store": store.name,
                "dev.lando.scope": store.scope,
                "dev.lando.volume-selector": `${plan.provider}:${plan.id}:${store.kind === "cache" ? "cache" : "data"}`,
                ...(store.kind === "cache" ? { "dev.lando.storage-kind": "cache" } : {}),
              },
            },
          }),
        );
        expect([200, 201, 409]).toContain(volumeCreate.status);

        const initializerName = `lando-${plan.slug}-${service.name}-subpath-init`;
        initializerContainers.add(initializerName);
        const create = await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: `/containers/create?name=${encodeURIComponent(initializerName)}`,
            body: {
              Image: "node:22-alpine",
              Cmd: ["mkdir", "-p", `/volume/${storage.subpath}`],
              HostConfig: { Binds: [`${store.name}:/volume`] },
            },
          }),
        );
        expect(create.status).toBe(201);

        const start = await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: `/containers/${encodeURIComponent(initializerName)}/start`,
          }),
        );
        expect(start.status).toBe(204);

        const wait = await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: `/containers/${encodeURIComponent(initializerName)}/wait`,
          }),
        );
        expect(wait.status).toBe(200);
        expect(field(JSON.parse(wait.body), "StatusCode")).toBe(0);

        const remove = await Effect.runPromise(
          liveRequest({
            method: "DELETE",
            path: `/containers/${encodeURIComponent(initializerName)}?force=true`,
          }),
        );
        expect(remove.status).toBe(204);
        initializerContainers.delete(initializerName);
      }
    }
    await Effect.runPromise(bringUp(plan, { podmanApi: api }));

    const containerName = `lando-${plan.slug}-${fixture.service}`;
    const response = await Effect.runPromise(
      liveRequest({ method: "GET", path: `/containers/${containerName}/json` }),
    );
    expect(response.status).toBe(200);
    const inspect: unknown = JSON.parse(response.body);
    assertServiceContainerRunning(inspect, containerName);
    fixture.assertInspect(inspect, appRoot);
  } finally {
    try {
      for (const initializerName of initializerContainers) {
        await Effect.runPromise(
          Effect.either(
            liveRequest({
              method: "DELETE",
              path: `/containers/${encodeURIComponent(initializerName)}?force=true`,
            }),
          ),
        );
      }
    } finally {
      try {
        if (plan !== undefined) {
          await Effect.runPromise(Effect.either(bringDown(plan, { podmanApi: api, volumes: true })));
        }
      } finally {
        await rm(appRoot, { recursive: true, force: true });
      }
    }
  }
};

const rejectFixtureBeforeProviderCall = async (fixture: RejectedFixtureCase): Promise<void> => {
  const appRoot = await realpath(await mkdtemp(join(tmpdir(), `lando-compose-${fixture.id}-`)));
  let providerCallCount = 0;

  try {
    const fixtureSource = await Bun.file(join(fixturesRoot, fixture.file)).text();
    const landofilePath = join(appRoot, ".lando.yml");
    await writeFile(landofilePath, makeRunnableLandofile(`compose-fixture-${fixture.id}`, fixtureSource));
    const landofile = await Effect.runPromise(loadLandofileFile(landofilePath));
    const api = makePodmanApiClient(liveSocketPath);
    const guardedApi = {
      ...api,
      request: () => {
        providerCallCount += 1;
        return Effect.die(new Error("Capability gate reached the provider request boundary."));
      },
      stream: () => {
        providerCallCount += 1;
        return Stream.die(new Error("Capability gate reached the provider stream boundary."));
      },
    };

    const exit = await Effect.runPromiseExit(
      AppPlanner.pipe(
        Effect.flatMap((planner) => planner.plan(landofile, providerLandoCapabilitiesForPlatform("linux"))),
        Effect.flatMap((plan) => bringUp(plan, { podmanApi: guardedApi })),
        Effect.provide(plannerLayer),
      ),
    );
    const failure = Exit.isFailure(exit) ? Cause.failureOption(exit.cause) : undefined;
    const error = failure?._tag === "Some" ? failure.value : undefined;

    expect(providerCallCount).toBe(0);
    expect(error).toBeInstanceOf(CapabilityError);
    if (!(error instanceof CapabilityError)) return;
    expect(error.service).toBe(fixture.service);
    expect(error.key).toBe(fixture.key);
    expect(error.capability).toBe("composeSpec");
    expect(error.providerId).toBe("lando");
    expect(error.remediation).toBeDefined();
  } finally {
    await rm(appRoot, { recursive: true, force: true });
  }
};

describe("provider-lando committed Compose fixtures (live)", () => {
  for (const fixture of fixtures) {
    test.skipIf(liveSocketPath.length === 0)(
      `Given the ${fixture.id} fixture, when production planning creates a live container, then inspect realizes its Compose intent`,
      () => runFixture(fixture),
      60_000,
    );
  }

  for (const fixture of rejectedFixtures) {
    test.skipIf(liveSocketPath.length === 0)(
      `Given the ${fixture.id} fixture, when planning precedes provider execution, then ${fixture.key} fails closed without a provider call`,
      () => rejectFixtureBeforeProviderCall(fixture),
      60_000,
    );
  }
});
