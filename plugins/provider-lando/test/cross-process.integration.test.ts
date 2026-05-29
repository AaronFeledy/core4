import { describe, expect, test } from "bun:test";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect } from "effect";

import { appliedPlanPath, makeProviderLayer } from "@lando/provider-lando";
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
      ? [{ port: 31082, protocol: "http", name: "http" }]
      : [{ port: 55434, protocol: "tcp", name: "database" }],
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
  stores: [{ name: "crossprocessapp_database_data", scope: "app" }],
  fileSync: [],
  metadata,
  extensions: {},
};

const fileExists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

const makeFakePodmanState = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const networks = new Set<string>();
  const volumes = new Set<string>(plan.stores.map((store) => store.name));
  const calls: PodmanHttpRequest[] = [];

  const api: PodmanApiClient = {
    info: Effect.succeed({}),
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
        if (request.method === "DELETE" && request.path.startsWith("/volumes/")) {
          const volume = decodeURIComponent(request.path.slice("/volumes/".length));
          const deleted = volumes.delete(volume);
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
      expect(fake.networks.size).toBe(0);
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
