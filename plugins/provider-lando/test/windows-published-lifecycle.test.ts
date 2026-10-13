import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import type { EngineHttpResponse, PodmanApiClient } from "@lando/container-runtime/engine-api";
import { makePluginStateStore } from "@lando/engine/plugins/context-state";
import { makeTestStateStore } from "@lando/engine/testing/state-store";
import { makeRuntimeProvider, persistAppliedPlan } from "@lando/provider-lando";
import type { PluginStateStore } from "@lando/sdk/plugins";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { ownerOnlyFileAccess } from "./private-file-access.ts";

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
  source: "windows-published-lifecycle.test",
  runtime: 4 as const,
};
const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("traefik");
const makePlan = (id: string): AppPlan => {
  const appId = AppId.make(id);
  const service: ServicePlan = {
    name: serviceName,
    type: "proxy",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "nginx:alpine" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  return {
    id: appId,
    name: id,
    slug: id,
    root: AbsolutePath.make(`/tmp/${id}`),
    provider: providerId,
    services: { [serviceName]: service },
    routes: [],
    networks: [],
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

describe("managed Windows published lifecycle", () => {
  test("fails closed before a global transition without private state but preserves other hosts and apps", async () => {
    const calls: string[] = [];
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.void,
      request: (request) => {
        calls.push(`${request.method} ${request.path}`);
        return Effect.succeed({ status: 204, body: "" });
      },
    };
    const options = {
      podmanApi: api,
      sanitizeAppliedPlan: (plan: AppPlan) => plan,
    };
    const windows = await Effect.runPromise(
      makeRuntimeProvider({
        ...options,
        platform: "win32",
        providerSocketPath: "\\\\.\\pipe\\podman-lando",
        podmanMachine: {
          inspect: Effect.succeed("running"),
          createdAt: Effect.succeed("created"),
          create: Effect.void,
          start: Effect.void,
          stop: Effect.void,
          upgrade: Effect.void,
          teardown: Effect.void,
          matchingPublishPorts: (ports) => Effect.succeed(ports),
        },
      }),
    );
    const global = makePlan("global");
    const blocked = await Effect.runPromise(
      Effect.result(windows.stop({ app: global.id, service: serviceName, plan: global })),
    );
    expect(blocked._tag).toBe("Failure");
    if (blocked._tag === "Failure") {
      expect(blocked.failure._tag).toBe("ProviderUnavailableError");
    }
    expect(calls).toEqual([]);

    const observedRemoval = await Effect.runPromise(
      Effect.result(
        windows.removeObservedService({
          app: global.id,
          service: serviceName,
          providerId,
          status: "running",
          containerId: "exact-global-id",
        }),
      ),
    );
    expect(observedRemoval._tag).toBe("Failure");
    if (windows.matchingPublishPorts === undefined) throw new Error("missing port matcher");
    const matching = await Effect.runPromise(
      Effect.result(windows.matchingPublishPorts("exact-global-id", [38080])),
    );
    expect(matching._tag).toBe("Failure");
    const destroyed = await Effect.runPromise(
      Effect.result(windows.destroy({ app: global.id, plan: global }, { volumes: false })),
    );
    expect(destroyed._tag).toBe("Failure");
    expect(calls).toEqual([]);

    const other = makePlan("other");
    await Effect.runPromise(windows.stop({ app: other.id, service: serviceName, plan: other }));
    expect(calls).toEqual(["POST /containers/lando-other-traefik/stop"]);

    const linux = await Effect.runPromise(
      makeRuntimeProvider({ ...options, platform: "linux", providerSocketPath: "/tmp/podman.sock" }),
    );
    await Effect.runPromise(linux.stop({ app: global.id, service: serviceName, plan: global }));
    expect(calls.at(-1)).toBe("POST /containers/lando-global-traefik/stop");
  });

  for (const action of ["quiesce", "destroy"] as const) {
    test(`uses the latest global receipt when ${action} waits for an in-flight apply`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "lando-published-stale-plan-"));
      const lockHeld = deferred();
      const releaseLock = deferred();
      const teardownWaiting = deferred();
      const calls: string[] = [];
      const baseState = makePluginStateStore(
        makeTestStateStore().service,
        AbsolutePath.make(directory),
        ownerOnlyFileAccess,
      );
      const stateStore: PluginStateStore = {
        ...baseState,
        withLock: (key, body, options) => {
          if (key === "windows-published-lifecycle") teardownWaiting.resolve();
          return baseState.withLock(key, body, options);
        },
      };
      const api: PodmanApiClient = {
        info: Effect.succeed({}),
        ping: Effect.void,
        request: (request) => {
          calls.push(`${request.method} ${request.path}`);
          return Effect.succeed({ status: 204, body: "" });
        },
      };
      const provider = await Effect.runPromise(
        makeRuntimeProvider({
          platform: "win32",
          providerSocketPath: "\\\\.\\pipe\\podman-lando",
          podmanApi: api,
          podmanMachine: {
            inspect: Effect.succeed("running"),
            createdAt: Effect.succeed("created"),
            create: Effect.void,
            start: Effect.void,
            stop: Effect.void,
            upgrade: Effect.void,
            teardown: Effect.void,
            matchingPublishPorts: (ports) => Effect.succeed(ports),
          },
          appliedPlanState: stateStore,
          sanitizeAppliedPlan: (plan) => plan,
        }),
      );
      const stale = makePlan("global");
      const extraName = ServiceName.make("metrics");
      const baseService = stale.services[serviceName];
      if (baseService === undefined) throw new Error("missing global service fixture");
      const newer: AppPlan = {
        ...stale,
        services: {
          ...stale.services,
          [extraName]: { ...baseService, name: extraName, primary: false },
        },
      };
      await Effect.runPromise(persistAppliedPlan(stateStore, stale));
      const hold = Effect.runPromise(
        baseState.withLock(
          "windows-published-lifecycle",
          Effect.promise(async () => {
            lockHeld.resolve();
            await releaseLock.promise;
          }),
        ),
      );
      try {
        await lockHeld.promise;
        const quiesce = provider.quiesceForFileSync;
        if (quiesce === undefined) throw new Error("missing global quiesce operation");
        const teardown =
          action === "quiesce"
            ? Effect.runPromise(quiesce({ app: stale.id, plan: stale }))
            : Effect.runPromise(provider.destroy({ app: stale.id, plan: stale }, { volumes: false }));
        await teardownWaiting.promise;
        expect(calls).toEqual([]);
        await Effect.runPromise(persistAppliedPlan(stateStore, newer));
        releaseLock.resolve();
        await teardown;
        expect(calls).toContain("POST /containers/lando-global-metrics/stop");
      } finally {
        releaseLock.resolve();
        await hold;
        await rm(directory, { recursive: true, force: true });
      }
    }, 10_000);
  }

  test("serializes direct global apply and router restart while unrelated apps proceed", async () => {
    const enteredGlobalStart = deferred();
    const releaseGlobalStart = deferred();
    const restartRequestedLock = deferred();
    const matchingRequestedLock = deferred();
    const calls: string[] = [];
    const lockCalls: Array<{ key: string; timeoutMs: number | undefined }> = [];
    const existing = new Set<string>();
    const running = new Set<string>();
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.void,
      request: (request) =>
        Effect.gen(function* (): Effect.fn.Return<EngineHttpResponse> {
          const path = request.path;
          const container = path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
          const name = container === null ? "" : decodeURIComponent(container[1] ?? "");
          const action = container?.[2];
          calls.push(`${request.method} ${path}`);
          if (request.method === "GET" && path.includes("/images/") && path.endsWith("/json"))
            return {
              status: 200,
              body: JSON.stringify({ Os: "linux", Architecture: "amd64", RepoDigests: ["img@sha256:test"] }),
            };
          if (request.method === "POST" && path === "/networks/create") return { status: 201, body: "{}" };
          if (request.method === "DELETE" && path.startsWith("/networks/")) return { status: 204, body: "" };
          if (request.method === "GET" && path === "/containers/router-id/json")
            return {
              status: 200,
              body: JSON.stringify({
                Id: "router-id",
                NetworkSettings: { Networks: { managed: { IPAddress: "10.89.1.2" } } },
              }),
            };
          if (request.method === "GET" && action === "json")
            return existing.has(name)
              ? {
                  status: 200,
                  body: JSON.stringify({
                    Id: name,
                    State: { Running: running.has(name), Status: running.has(name) ? "running" : "created" },
                    Mounts: [],
                    HostConfig: { PortBindings: {} },
                    NetworkSettings: { Networks: {} },
                  }),
                }
              : { status: 404, body: "{}" };
          if (request.method === "POST" && path.startsWith("/containers/create")) {
            const createdName = new URL(`http://localhost${path}`).searchParams.get("name") ?? "";
            existing.add(createdName);
            return { status: 201, body: "{}" };
          }
          if (request.method === "POST" && action === "start") {
            if (name === "lando-global-traefik") {
              enteredGlobalStart.resolve();
              yield* Effect.promise(() => releaseGlobalStart.promise);
            }
            running.add(name);
            return { status: 204, body: "" };
          }
          if (request.method === "POST" && action === "restart") {
            running.add(name);
            return { status: 204, body: "" };
          }
          if (request.method === "POST" && action === "stop") {
            running.delete(name);
            return { status: 204, body: "" };
          }
          if (request.method === "DELETE" && path.startsWith("/containers/")) {
            existing.delete(name);
            running.delete(name);
            return { status: 204, body: "" };
          }
          return { status: 500, body: `unexpected ${request.method} ${path}` };
        }),
    };
    const baseState = makePluginStateStore(
      makeTestStateStore().service,
      AbsolutePath.make("/tmp/windows-published-lifecycle"),
      ownerOnlyFileAccess,
    );
    const stateStore: PluginStateStore = {
      ...baseState,
      withLock: (key, body, options) => {
        lockCalls.push({ key, timeoutMs: options?.timeoutMs });
        const lifecycleLocks = lockCalls.filter((call) => call.key === "windows-published-lifecycle").length;
        if (lifecycleLocks === 2) restartRequestedLock.resolve();
        if (lifecycleLocks === 3) matchingRequestedLock.resolve();
        return baseState.withLock(key, body, options);
      },
    };
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "win32",
        providerSocketPath: "\\\\.\\pipe\\podman-lando",
        podmanApi: api,
        podmanMachine: {
          inspect: Effect.succeed("running"),
          createdAt: Effect.succeed("created"),
          create: Effect.void,
          start: Effect.void,
          stop: Effect.void,
          upgrade: Effect.void,
          teardown: Effect.void,
          matchingPublishPorts: (ports) => Effect.succeed(ports),
        },
        appliedPlanState: stateStore,
        sanitizeAppliedPlan: (plan) => plan,
      }),
    );
    const global = makePlan("global");
    const other = makePlan("other");
    const apply = Effect.runPromise(Effect.scoped(provider.apply(global, { reconcile: true })));
    await enteredGlobalStart.promise;
    const restart = Effect.runPromise(
      provider.restart({ app: global.id, service: serviceName, plan: global }),
    );
    if (provider.matchingPublishPorts === undefined) throw new Error("missing port matcher");
    const matching = Effect.runPromise(provider.matchingPublishPorts("router-id", [38080]));
    try {
      await restartRequestedLock.promise;
      await matchingRequestedLock.promise;
      expect(calls.some((call) => call.endsWith("/containers/lando-global-traefik/restart"))).toBe(false);
      expect(calls.some((call) => call === "GET /containers/router-id/json")).toBe(false);
      await Effect.runPromise(Effect.scoped(provider.apply(other, { reconcile: true })));
      expect(running.has("lando-other-traefik")).toBe(true);
      expect(lockCalls.filter((call) => call.key === "windows-published-lifecycle")).toHaveLength(3);
    } finally {
      releaseGlobalStart.resolve();
    }
    await apply;
    await restart;
    expect(await matching).toEqual([38080]);
    expect(
      calls.filter((call) => call.includes("lando-global-traefik") && call.endsWith("/restart")),
    ).toHaveLength(1);
    expect(lockCalls.filter((call) => call.key === "windows-published-lifecycle")).toEqual([
      { key: "windows-published-lifecycle", timeoutMs: 120_000 },
      { key: "windows-published-lifecycle", timeoutMs: 120_000 },
      { key: "windows-published-lifecycle", timeoutMs: 120_000 },
    ]);
  }, 10_000);
});
