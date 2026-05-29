import { describe, expect, test } from "bun:test";

import { DateTime, Effect } from "effect";

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

const providerId = ProviderId.make("lando");
const appId = AppId.make("bringdownapp");
const appRoot = AbsolutePath.make("/tmp/lando-bringdown-app");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "bring-down.integration.test",
  runtime: 4 as const,
};

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
  stores: [{ name: "bringdownapp_database_data", scope: "app" }],
  metadata,
  extensions: {},
};

const makeFakeApi = () => {
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
          const requestedName = (request.body as { Name?: string }).Name ?? "";
          networks.add(requestedName);
          return { status: 201, body: "{}" };
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
          return { status: volumes.has(volume) ? 200 : 404, body: "{}" };
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

  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "stops and removes live Podman containers and network while preserving volumes",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
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
});
