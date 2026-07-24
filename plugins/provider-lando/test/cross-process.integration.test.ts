import { describe, expect, test } from "bun:test";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import {
  HOST_PROXY_CONTAINER_LANDO,
  HOST_PROXY_CONTAINER_SHIM,
  HOST_PROXY_CONTAINER_SOCKET,
} from "@lando/core/host-proxy-transport";
import { appliedPlanPath, makeProviderLayer } from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";
import type { PodmanServiceRunner } from "../src/podman-service-runner.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("crossprocessapp");
const appRoot = AbsolutePath.make("/tmp/lando-crossprocess-app");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "cross-process.integration.test",
  runtime: 4 as const,
};

const servicePlan = (name: "web" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "web" ? "node" : "postgres",
  provider: providerId,
  primary: name === "web",
  artifact: { kind: "ref", ref: name === "web" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "web" ? ["node", "-e", "setInterval(() => {}, 1000)"] : ["postgres"],
  environment: name === "web" ? {} : { POSTGRES_PASSWORD: "lando", POSTGRES_DB: "lando" },
  mounts: [],
  storage:
    name === "database"
      ? [
          {
            store: "crossprocessapp_database_data",
            target: PortablePath.make("/var/lib/postgresql/data"),
            readOnly: false,
          },
        ]
      : [],
  endpoints:
    name === "web"
      ? [{ _tag: "internal", port: 31082, protocol: "http", name: "http" }]
      : [{ _tag: "internal", port: 55434, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: name === "web" ? [{ service: ServiceName.make("database"), condition: "started" }] : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const web = servicePlan("web");
const database = servicePlan("database");
const plan: AppPlan = {
  id: appId,
  name: "Cross Process App",
  slug: "crossprocessapp",
  root: appRoot,
  provider: providerId,
  services: { [database.name]: database, [web.name]: web },
  routes: [],
  networks: [],
  stores: [{ name: "crossprocessapp_database_data", scope: "app", kind: "data" }],
  fileSync: [],
  metadata,
  extensions: {},
};

const hostProxyPlan: AppPlan = {
  ...plan,
  services: {
    ...plan.services,
    [web.name]: {
      ...web,
      environment: {
        LANDO_APP_NAME: "demo",
        LANDO_HOST_PROXY_TRANSPORT: "unix-socket",
        LANDO_HOST_PROXY_SOCKET: HOST_PROXY_CONTAINER_SOCKET,
        LANDO_HOST_PROXY_TOKEN: "secret-token",
        LANDO_HOST_PROXY_SESSION: "session-id",
        LANDO_HOST_PROXY_APP: "crossprocessapp",
        LANDO_HOST_PROXY_DEPTH: "0",
      },
      mounts: [
        {
          type: "bind",
          source: "/tmp/host-proxy.sock",
          target: PortablePath.make(HOST_PROXY_CONTAINER_SOCKET),
          readOnly: true,
          realization: "passthrough",
        },
        {
          type: "bind",
          source: "/tmp/lando-shim",
          target: PortablePath.make(HOST_PROXY_CONTAINER_SHIM),
          readOnly: true,
          realization: "passthrough",
        },
        {
          type: "bind",
          source: "/tmp/lando-shim",
          target: PortablePath.make(HOST_PROXY_CONTAINER_LANDO),
          readOnly: true,
          realization: "passthrough",
        },
      ],
    },
  },
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

type RuntimeServiceCall =
  | ["launch", string]
  | ["isAlive", number]
  | ["isServiceProcess", number, string]
  | ["terminate", number];

const unavailable = () =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "podman-api",
    message: "unreachable",
    remediation: "test remediation",
  });

const runtimePaths = (dir: string) => ({
  runtimeBinDir: join(dir, "bin"),
  runtimeStorageDir: join(dir, "storage"),
  runtimeRunDir: join(dir, "run"),
  runtimeConfigDir: join(dir, "config"),
  providerSocketPath: join(dir, "podman.sock"),
  providerPidPath: join(dir, "podman.pid"),
});

const canonicalRuntimeArgs = (paths: ReturnType<typeof runtimePaths>) =>
  JSON.stringify([
    "--root",
    paths.runtimeStorageDir,
    "--runroot",
    paths.runtimeRunDir,
    "--config",
    paths.runtimeConfigDir,
    "--storage-opt",
    `overlay.mount_program=${paths.runtimeBinDir}/fuse-overlayfs`,
    "system",
    "service",
    "--time=0",
    `unix://${paths.providerSocketPath}`,
  ]);

const fakeServiceRunner = (
  calls: RuntimeServiceCall[],
  isAlive: (pid: number) => boolean,
  onLaunch: (pid: number) => void,
): PodmanServiceRunner => ({
  launch: (spec) =>
    Effect.sync(() => {
      calls.push(["launch", JSON.stringify(spec.args)]);
      const pid = 9999 + calls.filter((call) => call[0] === "launch").length;
      onLaunch(pid);
      return pid;
    }),
  isAlive: (pid) =>
    Effect.sync(() => {
      calls.push(["isAlive", pid]);
      return isAlive(pid);
    }),
  isServiceProcess: (pid, spec) =>
    Effect.sync(() => {
      calls.push(["isServiceProcess", pid, JSON.stringify(spec.args)]);
      return isAlive(pid);
    }),
  terminate: (pid) =>
    Effect.sync(() => {
      calls.push(["terminate", pid]);
    }),
});

const makeFakePodmanState = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const networks = new Set<string>();
  const volumes = new Set<string>(plan.stores.map((store) => store.name));
  const volumeLabels = new Map<string, Readonly<Record<string, string>>>(
    plan.stores.map((store): readonly [string, Readonly<Record<string, string>>] => [
      store.name,
      {
        "dev.lando.volume-selector": `lando:${plan.id}:${store.kind === "cache" ? "cache" : "data"}`,
      },
    ]),
  );
  const calls: PodmanHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
        calls.push(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const name = containerMatch === null ? "" : decodeURIComponent(containerMatch[1] ?? "");
        const action = containerMatch?.[2];

        if (request.path === "/networks/create") {
          const requested = (request.body as { Name?: string }).Name ?? "";
          networks.add(requested);
          return { status: 201, body: "{}" };
        }
        if (request.path === "/volumes/create") {
          const body = request.body as { Name?: string; Labels?: Readonly<Record<string, string>> };
          const requested = body.Name ?? "";
          const existed = volumes.has(requested);
          volumes.add(requested);
          if (!existed && body.Labels !== undefined) volumeLabels.set(requested, body.Labels);
          return { status: existed ? 409 : 201, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/libpod/volumes/prune")) {
          return { status: 200, body: "[]" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          const network = decodeURIComponent(request.path.slice("/networks/".length));
          const deleted = networks.delete(network);
          return { status: deleted ? 204 : 404, body: "" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const created = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          if (existing.has(created)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(created);
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && action === "json") {
          if (!existing.has(name)) {
            return { status: 404, body: "{}" };
          }
          return {
            status: 200,
            body: JSON.stringify({
              State: { Running: running.has(name), Status: running.has(name) ? "running" : "created" },
            }),
          };
        }
        if (request.method === "POST" && action === "start") {
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && action === "stop") {
          if (!existing.has(name)) {
            return { status: 404, body: "" };
          }
          const stopped = running.delete(name);
          return { status: stopped ? 204 : 304, body: "" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/containers/")) {
          const deleted = existing.delete(name);
          running.delete(name);
          return { status: deleted ? 204 : 404, body: "" };
        }
        if (request.method === "GET" && request.path.startsWith("/volumes/")) {
          const volume = decodeURIComponent(request.path.slice("/volumes/".length));
          return {
            status: volumes.has(volume) ? 200 : 404,
            body: JSON.stringify({ Labels: volumeLabels.get(volume) ?? {} }),
          };
        }
        if (request.method === "DELETE" && request.path.startsWith("/volumes/")) {
          const volume = decodeURIComponent(request.path.slice("/volumes/".length));
          const deleted = volumes.delete(volume);
          volumeLabels.delete(volume);
          return { status: deleted ? 204 : 404, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };

  return { api, calls, existing, running, networks, volumes };
};

const withStateDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-crossprocess-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runOnce = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("provider-lando cross-process state", () => {
  test("persists a host-proxy-sanitized applied plan while applying the runtime plan", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakePodmanState();

      const provider = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );
      await runOnce(provider.apply(hostProxyPlan, { reconcile: false }).pipe(Effect.scoped));

      const persisted = await readFile(appliedPlanPath(stateDir, hostProxyPlan.id), "utf8");
      expect(persisted).not.toContain("LANDO_HOST_PROXY_TOKEN");
      expect(persisted).not.toContain("LANDO_HOST_PROXY_SESSION");
      expect(persisted).not.toContain("LANDO_HOST_PROXY_SOCKET");
      expect(persisted).not.toContain("LANDO_HOST_PROXY_DEPTH");
      expect(persisted).not.toContain("host-proxy.sock");
      expect(persisted).not.toContain(HOST_PROXY_CONTAINER_SHIM);
      expect(persisted).not.toContain(HOST_PROXY_CONTAINER_LANDO);

      const createdBodies = fake.calls
        .filter((call) => call.method === "POST" && call.path.startsWith("/containers/create"))
        .map((call) => JSON.stringify(call.body));
      expect(createdBodies.join("\n")).toContain("LANDO_HOST_PROXY_TOKEN");
    });
  });

  test("a fresh provider layer can inspect and destroy an app applied by an earlier layer", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakePodmanState();

      const providerA = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );
      await runOnce(providerA.apply(plan, { reconcile: false }).pipe(Effect.scoped));

      expect(await fileExists(appliedPlanPath(stateDir, plan.id))).toBe(true);
      expect(fake.existing.has("lando-crossprocessapp-database")).toBe(true);
      expect(fake.existing.has("lando-crossprocessapp-web")).toBe(true);

      const providerB = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );

      const snapshot = await runOnce(providerB.inspect({ app: plan.id, service: web.name }));
      expect(snapshot.app).toBe(plan.id);
      expect(snapshot.service).toBe(web.name);
      expect(snapshot.state).toBe("running");

      await runOnce(providerB.destroy({ app: plan.id }, { volumes: false }));

      expect(fake.existing.size).toBe(0);
      expect(Array.from(fake.networks)).toEqual(["lando_bridge_network"]);
      expect(fake.volumes.has("crossprocessapp_database_data")).toBe(true);
      expect(await fileExists(appliedPlanPath(stateDir, plan.id))).toBe(false);
    });
  });

  test("destroy with volumes=true removes app-scoped volumes", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakePodmanState();

      const providerA = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );
      await runOnce(providerA.apply(plan, { reconcile: false }).pipe(Effect.scoped));

      const providerB = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );

      await runOnce(providerB.destroy({ app: plan.id }, { volumes: true }));

      expect(fake.volumes.has("crossprocessapp_database_data")).toBe(false);
      expect(await fileExists(appliedPlanPath(stateDir, plan.id))).toBe(false);
    });
  });

  test("stop-style destroy keeps applied state for a later fresh-process inspect", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakePodmanState();

      const providerA = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );
      await runOnce(providerA.apply(plan, { reconcile: false }).pipe(Effect.scoped));

      const providerB = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );
      await runOnce(providerB.destroy({ app: plan.id }, { volumes: false, removeState: false }));

      expect(await fileExists(appliedPlanPath(stateDir, plan.id))).toBe(true);

      const providerC = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );
      const snapshot = await runOnce(providerC.inspect({ app: plan.id, service: web.name }));

      expect(snapshot.app).toBe(plan.id);
      expect(snapshot.service).toBe(web.name);
      expect(snapshot.state).toBe("stopped");
    });
  });

  test("the same provider layer self-heals a killed managed runtime before inspect", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakePodmanState();
      const paths = runtimePaths(stateDir);
      const serviceCalls: RuntimeServiceCall[] = [];
      const livePids = new Set<number>();
      const launchCount = () => serviceCalls.filter((call) => call[0] === "launch").length;
      const serviceRunner = fakeServiceRunner(
        serviceCalls,
        (pid) => livePids.has(pid),
        (pid) => livePids.add(pid),
      );
      let forceUnreachableUntilNextLaunch = false;
      let launchBaseline = 0;
      const pingObservations: string[] = [];
      const podmanApi: PodmanApiClient = {
        ...fake.api,
        ping: Effect.gen(function* () {
          if (!forceUnreachableUntilNextLaunch || launchCount() > launchBaseline) {
            pingObservations.push("reachable");
            return;
          }
          pingObservations.push("unreachable-after-kill");
          return yield* Effect.fail(unavailable());
        }),
      };

      const provider = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              podmanApi,
              podmanService: serviceRunner,
              stateDir,
              platform: "linux",
              ...paths,
            }),
          ),
        ),
      );
      await runOnce(provider.apply(plan, { reconcile: false }).pipe(Effect.scoped));

      const firstLaunches = launchCount();
      expect(firstLaunches).toBe(1);
      expect(serviceCalls).toContainEqual(["launch", canonicalRuntimeArgs(paths)]);
      const firstPid = Number(await readFile(paths.providerPidPath, "utf8"));
      expect(livePids.has(firstPid)).toBe(true);

      launchBaseline = firstLaunches;
      forceUnreachableUntilNextLaunch = true;
      livePids.delete(firstPid);

      const snapshot = await runOnce(provider.inspect({ app: plan.id, service: web.name }));

      expect(snapshot.app).toBe(plan.id);
      expect(snapshot.service).toBe(web.name);
      expect(snapshot.state).toBe("running");
      expect(launchCount()).toBe(firstLaunches + 1);
      expect(serviceCalls.slice(-2)).toEqual([
        ["isAlive", firstPid],
        ["launch", canonicalRuntimeArgs(paths)],
      ]);
      const healedPid = Number(await readFile(paths.providerPidPath, "utf8"));
      expect(healedPid).not.toBe(firstPid);
      expect(livePids.has(healedPid)).toBe(true);
      expect(pingObservations).toContain("unreachable-after-kill");
      expect(pingObservations.at(-1)).toBe("reachable");
    });
  });

  test("destroy is idempotent across a missing applied-state file", async () => {
    await withStateDir(async (stateDir) => {
      const fake = makeFakePodmanState();

      const provider = await runOnce(
        RuntimeProvider.pipe(
          Effect.provide(makeProviderLayer({ podmanApi: fake.api, stateDir, platform: "linux" })),
        ),
      );

      await runOnce(provider.destroy({ app: plan.id }, { volumes: false }));
    });
  });
});
