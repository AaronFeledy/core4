import { describe, expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringDown, bringUp, makePodmanApiClient } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { LandoEvent } from "@lando/sdk/services";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";
import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("bringdownapp");
const appRoot = AbsolutePath.make("/tmp/lando-bringdown-app");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "bring-down.integration.test",
  runtime: 4 as const,
};
const volumePruneLive = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_VOLUME_PRUNE === "1",
    reason: "LANDO_TEST_VOLUME_PRUNE=1 is required",
  },
  { available: resolveLiveProviderSocket() !== undefined, reason: "a live Podman socket is required" },
]);

const servicePlan = (name: "node" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "node" ? "node" : "postgres",
  provider: providerId,
  primary: name === "node",
  artifact: { kind: "ref", ref: name === "node" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "node" ? ["node", "-e", "setInterval(() => {}, 1000)"] : ["postgres", "-c", "port=55432"],
  environment: name === "node" ? {} : { POSTGRES_PASSWORD: "lando", POSTGRES_DB: "lando" },
  appMount:
    name === "node"
      ? {
          source: appRoot,
          target: PortablePath.make("/app"),
          readOnly: false,
          excludes: [],
          includes: [],
          realization: "passthrough",
        }
      : undefined,
  mounts: [],
  storage:
    name === "database"
      ? [
          {
            store: "bringdownapp_database_data",
            target: PortablePath.make("/var/lib/postgresql/data"),
            readOnly: false,
          },
        ]
      : [],
  endpoints:
    name === "node"
      ? [{ port: 31081, protocol: "http", name: "http" }]
      : [{ port: 55433, protocol: "tcp", name: "database" }],
  routes: [],
  dependsOn: name === "node" ? [{ service: ServiceName.make("database"), condition: "started" }] : [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const database = servicePlan("database");
const node = servicePlan("node");

const plan: AppPlan = {
  id: appId,
  name: "BringDown App",
  slug: "bringdownapp",
  root: appRoot,
  provider: providerId,
  services: { [database.name]: database, [node.name]: node },
  routes: [],
  networks: [],
  stores: [
    { name: "bringdownapp_database_data", scope: "app", kind: "data" },
    { name: "lando-cache-npm", scope: "global", kind: "cache", key: "npm" },
  ],
  fileSync: [],
  metadata,
  extensions: {},
};

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const networks = new Set<string>();
  const volumes = new Set<string>(plan.stores.map((store) => store.name));
  const volumeLabels = new Map<string, Readonly<Record<string, string>>>(
    plan.stores.map((store) => [
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
          const requestedName = (request.body as { Name?: string }).Name ?? "";
          networks.add(requestedName);
          return { status: 201, body: "{}" };
        }
        if (request.path === "/volumes/create") {
          const body = request.body as { Name?: string; Labels?: Readonly<Record<string, string>> };
          const requestedName = body.Name ?? "";
          const existed = volumes.has(requestedName);
          volumes.add(requestedName);
          if (!existed && body.Labels !== undefined) volumeLabels.set(requestedName, body.Labels);
          return { status: existed ? 409 : 201, body: "{}" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          const network = decodeURIComponent(request.path.slice("/networks/".length));
          const deleted = networks.delete(network);
          return { status: deleted ? 204 : 404, body: "" };
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
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const createdName = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(createdName);
          return { status: 201, body: "{}" };
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
          const volume = decodeURIComponent(request.path.slice("/volumes/".length).replace(/\/json$/u, ""));
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
        if (request.method === "POST" && request.path.startsWith("/libpod/volumes/prune")) {
          return { status: 200, body: "[]" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls, existing, networks, volumes };
};

describe("provider-lando bringDown", () => {
  test("stops and removes every service, removes the app network, preserves volumes, and is idempotent", async () => {
    const fake = makeFakeApi();
    const events: LandoEvent[] = [];
    const eventService = {
      publish: (event: LandoEvent) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
    };

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));
    const first = await Effect.runPromise(bringDown(plan, { podmanApi: fake.api, eventService }));
    const second = await Effect.runPromise(bringDown(plan, { podmanApi: fake.api, eventService }));

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(fake.existing.size).toBe(0);
    expect(Array.from(fake.networks)).toEqual(["lando_bridge_network"]);
    expect(fake.volumes.has("bringdownapp_database_data")).toBe(true);
    expect(fake.volumes.has("lando-cache-npm")).toBe(true);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      false,
    );
    expect(events.map((event) => event._tag)).toEqual([
      "pre-service-stop",
      "post-service-stop",
      "pre-service-stop",
      "post-service-stop",
      "pre-service-stop",
      "post-service-stop",
      "pre-service-stop",
      "post-service-stop",
    ]);
  });

  test("purgeCaches removes cache volumes without removing app data volumes", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));
    await Effect.runPromise(bringDown(plan, { podmanApi: fake.api, volumes: false, purgeCaches: true }));

    expect(fake.volumes.has("bringdownapp_database_data")).toBe(true);
    expect(fake.volumes.has("lando-cache-npm")).toBe(false);
  });

  test("does not directly delete a planned volume owned by another app", async () => {
    const foreignPlan: AppPlan = {
      ...plan,
      services: {},
      stores: [{ name: "foreign-data", scope: "app", kind: "data" }],
    };
    const calls: PodmanHttpRequest[] = [];
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.succeed(undefined),
      request: (request) =>
        Effect.sync(() => {
          calls.push(request);
          if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
            return { status: 404, body: "" };
          }
          if (request.method === "GET" && request.path === "/volumes/foreign-data") {
            return {
              status: 200,
              body: JSON.stringify({ Labels: { "dev.lando.volume-selector": "lando:otherapp:data" } }),
            };
          }
          if (request.method === "DELETE" && request.path === "/volumes/foreign-data") {
            return { status: 204, body: "" };
          }
          if (request.method === "POST" && request.path.startsWith("/libpod/volumes/prune")) {
            return { status: 200, body: "[]" };
          }
          return { status: 500, body: `unexpected ${request.method} ${request.path}` };
        }),
    };

    await Effect.runPromise(bringDown(foreignPlan, { podmanApi: api, volumes: true }));

    expect(calls).toContainEqual({ method: "GET", path: "/volumes/foreign-data" });
    expect(calls).not.toContainEqual({ method: "DELETE", path: "/volumes/foreign-data" });
  });

  test("purgeCaches-only prune is cache-label positive and cannot match ordinary app volumes", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));
    await Effect.runPromise(bringDown(plan, { podmanApi: fake.api, purgeCaches: true }));

    const prune = fake.calls.find((call) => call.path.startsWith("/libpod/volumes/prune"));
    expect(prune).toBeDefined();
    const filters = JSON.parse(
      decodeURIComponent(new URL(`http://localhost${prune?.path ?? ""}`).searchParams.get("filters") ?? "{}"),
    ) as Record<string, readonly string[]>;
    expect(filters.label).toEqual(["dev.lando.volume-selector=lando:bringdownapp:cache"]);
    expect(filters["label!"]).toBeUndefined();
    expect(filters.all).toBeUndefined();
  });

  test("volumes cleanup prunes only current app/provider-scoped volumes with named-volume intent", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));
    await Effect.runPromise(bringDown(plan, { podmanApi: fake.api, volumes: true }));

    const prune = fake.calls.find((call) => call.path.startsWith("/libpod/volumes/prune"));
    expect(prune).toBeDefined();
    const pruneUrl = new URL(`http://localhost${prune?.path ?? ""}`);
    const filters = JSON.parse(decodeURIComponent(pruneUrl.searchParams.get("filters") ?? "{}")) as Record<
      string,
      readonly string[]
    >;
    expect(filters.label).toEqual(["dev.lando.volume-selector=lando:bringdownapp:data"]);
    expect(filters.all).toBeUndefined();
    expect(pruneUrl.searchParams.get("all")).toBe("true");
  });

  test("volumes cleanup with purgeCaches ORs only fully ownership-scoped cache and data selectors", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));
    await Effect.runPromise(bringDown(plan, { podmanApi: fake.api, volumes: true, purgeCaches: true }));

    const prune = fake.calls.find((call) => call.path.startsWith("/libpod/volumes/prune"));
    expect(prune).toBeDefined();
    const pruneUrl = new URL(`http://localhost${prune?.path ?? ""}`);
    const filters = JSON.parse(decodeURIComponent(pruneUrl.searchParams.get("filters") ?? "{}")) as Record<
      string,
      readonly string[]
    >;
    expect(filters.label).toEqual([
      "dev.lando.volume-selector=lando:bringdownapp:cache",
      "dev.lando.volume-selector=lando:bringdownapp:data",
    ]);
    expect(filters.all).toBeUndefined();
    expect(pruneUrl.searchParams.get("all")).toBe("true");
  });

  test("default cleanup does not prune named volumes without explicit destructive intent", async () => {
    const fake = makeFakeApi();

    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));
    await Effect.runPromise(bringDown(plan, { podmanApi: fake.api }));

    expect(fake.calls.some((call) => call.path.startsWith("/libpod/volumes/prune"))).toBe(false);
  });

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "stops and removes live Podman containers and network while preserving volumes",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");
      const liveRequest = api.request;
      if (liveRequest === undefined) {
        throw new Error("missing request client");
      }

      await Effect.runPromise(
        Effect.either(
          liveRequest({
            method: "POST",
            path: "/volumes/create",
            body: { Name: "bringdownapp_database_data" },
          }),
        ),
      );

      try {
        await Effect.runPromise(bringUp(plan, { podmanApi: api }));
        const result = await Effect.runPromise(bringDown(plan, { podmanApi: api }));

        expect(result.changed).toBe(true);
        for (const service of Object.values(plan.services)) {
          const response = await Effect.runPromise(
            liveRequest({ method: "GET", path: `/containers/lando-${plan.slug}-${service.name}/json` }),
          );
          expect(response.status).toBe(404);
        }
        const network = await Effect.runPromise(
          liveRequest({ method: "GET", path: `/networks/lando-${plan.slug}` }),
        );
        expect(network.status).toBe(404);
        const volume = await Effect.runPromise(
          liveRequest({ method: "GET", path: "/volumes/bringdownapp_database_data" }),
        );
        expect(volume.status).toBe(200);
      } finally {
        for (const service of Object.values(plan.services)) {
          await Effect.runPromise(
            Effect.either(
              liveRequest({ method: "POST", path: `/containers/lando-${plan.slug}-${service.name}/stop` }),
            ),
          );
          await Effect.runPromise(
            Effect.either(
              liveRequest({
                method: "DELETE",
                path: `/containers/lando-${plan.slug}-${service.name}?force=true`,
              }),
            ),
          );
        }
        await Effect.runPromise(
          Effect.either(liveRequest({ method: "DELETE", path: `/networks/lando-${plan.slug}` })),
        );
      }
    },
    60_000,
  );

  test.skipIf(!volumePruneLive.available)(
    liveIntegrationTestName(
      "prunes only explicitly created current-app/provider volumes when enabled",
      volumePruneLive,
    ),
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");
      const liveRequest = api.request;
      if (liveRequest === undefined) throw new Error("missing request client");
      const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const owned = `us436-prune-owned-${suffix}`;
      const other = `us436-prune-other-${suffix}`;

      try {
        await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: "/volumes/create",
            body: {
              Name: owned,
              Labels: {
                "dev.lando.app": "bringdownapp",
                "dev.lando.provider": "lando",
                "dev.lando.volume-selector": "lando:bringdownapp:data",
              },
            },
          }),
        );
        await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: "/volumes/create",
            body: {
              Name: other,
              Labels: {
                "dev.lando.app": "other",
                "dev.lando.provider": "lando",
                "dev.lando.volume-selector": "lando:other:data",
              },
            },
          }),
        );

        await Effect.runPromise(bringDown(plan, { podmanApi: api, volumes: true }));

        const ownedAfter = await Effect.runPromise(liveRequest({ method: "GET", path: `/volumes/${owned}` }));
        const otherAfter = await Effect.runPromise(liveRequest({ method: "GET", path: `/volumes/${other}` }));
        expect(ownedAfter.status).toBe(404);
        expect(otherAfter.status).toBe(200);
      } finally {
        for (const name of [owned, other]) {
          await Effect.runPromise(Effect.either(liveRequest({ method: "DELETE", path: `/volumes/${name}` })));
        }
      }
    },
  );
});
