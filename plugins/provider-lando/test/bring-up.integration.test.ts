import { describe, expect, test } from "bun:test";
import { DateTime, Effect, Exit } from "effect";

import { bringUp, makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { type LandoEvent, RuntimeProvider } from "@lando/sdk/services";
import type { PodmanApiClient, PodmanHttpRequest, PodmanHttpResponse } from "../src/capabilities.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("bringupapp");
const appRoot = AbsolutePath.make("/tmp/lando-bringup-app");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-14T00:00:00Z"),
  source: "bring-up.integration.test",
  runtime: 4 as const,
};
const nodeCommand = [
  "node",
  "-e",
  "require('http').createServer((_,res)=>res.end('lando-bringup-ok')).listen(31080)",
];

const servicePlan = (name: "node" | "database"): ServicePlan => ({
  name: ServiceName.make(name),
  type: name === "node" ? "node" : "postgres",
  provider: providerId,
  primary: name === "node",
  artifact: { kind: "ref", ref: name === "node" ? "node:22-alpine" : "postgres:16-alpine" },
  command: name === "node" ? nodeCommand : ["postgres", "-c", "port=55432"],
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
  storage: [],
  endpoints:
    name === "node"
      ? [{ port: 31080, protocol: "http", name: "http" }]
      : [{ port: 55432, protocol: "tcp", name: "database" }],
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
  name: "BringUp App",
  slug: "bringupapp",
  root: appRoot,
  provider: providerId,
  services: { [database.name]: database, [node.name]: node },
  routes: [],
  networks: [],
  stores: [],
  metadata,
  extensions: {},
};

interface CreateContainerBody {
  readonly Cmd?: ReadonlyArray<string>;
  readonly HostConfig?: {
    readonly Binds?: ReadonlyArray<string>;
  };
}

const makeFakeApi = () => {
  const running = new Set<string>();
  const existing = new Set<string>();
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
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const createdName = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          if (running.has(name)) {
            return { status: 304, body: "" };
          }
          running.add(name);
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && action === "stop") {
          running.delete(name);
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls, running };
};

describe("provider-lando bringUp", () => {
  test("starts every service, publishes lifecycle events, and is idempotent", async () => {
    const fake = makeFakeApi();
    const events: LandoEvent[] = [];
    const eventService = {
      publish: (event: LandoEvent) => Effect.sync(() => events.push(event)).pipe(Effect.asVoid),
    };

    const first = await Effect.runPromise(bringUp(plan, { podmanApi: fake.api, eventService }));
    const second = await Effect.runPromise(bringUp(plan, { podmanApi: fake.api, eventService }));

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    expect(Array.from(fake.running).sort()).toEqual(["lando-bringupapp-database", "lando-bringupapp-node"]);
    expect(events.map((event) => event._tag)).toEqual([
      "pre-service-start",
      "post-service-start",
      "pre-service-start",
      "post-service-start",
      "pre-service-start",
      "post-service-start",
      "pre-service-start",
      "post-service-start",
    ]);
    expect(fake.calls.some((call) => call.path === "/networks/create")).toBe(true);
    expect(fake.calls.some((call) => call.path.includes("/start"))).toBe(true);
    const nodeCreate = fake.calls.find(
      (call) =>
        call.method === "POST" &&
        call.path.startsWith("/containers/create") &&
        new URL(`http://localhost${call.path}`).searchParams.get("name") === "lando-bringupapp-node",
    );
    const nodeCreateBody = nodeCreate?.body as CreateContainerBody | undefined;
    expect(nodeCreateBody?.Cmd).toEqual(nodeCommand);
    expect(nodeCreateBody?.HostConfig?.Binds).toEqual([`${appRoot}:/app`]);
  });

  test("fails passthrough bind mounts without a source before creating the container", async () => {
    const fake = makeFakeApi();
    const invalidNode: ServicePlan = {
      ...node,
      dependsOn: [],
      appMount: undefined,
      mounts: [
        {
          type: "bind",
          target: PortablePath.make("/cache"),
          readOnly: false,
          realization: "passthrough",
        },
      ],
    };
    const invalidPlan: AppPlan = {
      ...plan,
      services: { [invalidNode.name]: invalidNode },
      stores: [],
    };

    const exit = await Effect.runPromiseExit(bringUp(invalidPlan, { podmanApi: fake.api }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.calls.some((call) => call.path.startsWith("/containers/create"))).toBe(false);
  });

  test("preserves string command quoting by using shell form", async () => {
    const fake = makeFakeApi();
    const command = "node -e \"console.log('hello world')\"";
    const shellNode: ServicePlan = {
      ...node,
      dependsOn: [],
      command,
    };
    const shellPlan: AppPlan = {
      ...plan,
      services: { [shellNode.name]: shellNode },
      stores: [],
    };

    await Effect.runPromise(bringUp(shellPlan, { podmanApi: fake.api }));

    const nodeCreate = fake.calls.find(
      (call) => call.method === "POST" && call.path.startsWith("/containers/create"),
    );
    const nodeCreateBody = nodeCreate?.body as CreateContainerBody | undefined;
    expect(nodeCreateBody?.Cmd).toEqual(["sh", "-lc", command]);
  });

  test("cleans up already-started services when cancellation is observed", async () => {
    const fake = makeFakeApi();
    const controller = new AbortController();
    const eventService = {
      publish: (event: LandoEvent) =>
        Effect.sync(() => {
          if (event._tag === "post-service-start") {
            controller.abort();
          }
        }),
    };

    const exit = await Effect.runPromiseExit(
      bringUp(plan, { podmanApi: fake.api, eventService, signal: controller.signal }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.running.size).toBe(0);
    expect(fake.calls.some((call) => call.path.includes("/stop"))).toBe(true);
  });

  test("RuntimeProvider apply delegates to bringUp", async () => {
    const fake = makeFakeApi();
    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ podmanApi: fake.api }))),
    );

    const result = await Effect.runPromise(provider.apply(plan, { reconcile: true }).pipe(Effect.scoped));

    expect(result.changed).toBe(true);
    expect(fake.running.has("lando-bringupapp-node")).toBe(true);
  });

  test.skipIf(!process.env.LANDO_TEST_PODMAN_SOCKET)(
    "brings up Node and Postgres services against a live Podman socket",
    async () => {
      const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");
      const liveRequest = api.request;
      if (liveRequest === undefined) {
        throw new Error("missing request client");
      }
      try {
        const result = await Effect.runPromise(bringUp(plan, { podmanApi: api }));
        expect(result.changed).toBe(true);

        for (const service of Object.values(plan.services)) {
          const response = await Effect.runPromise(
            liveRequest({ method: "GET", path: `/containers/lando-${plan.slug}-${service.name}/json` }),
          );
          expect(response.status).toBe(200);
          expect(response.body).toContain('"Running":true');
        }

        const httpResponse = await fetch("http://127.0.0.1:31080");
        const responseBody = await httpResponse.text();
        expect(responseBody).toBe("lando-bringup-ok");
        const socket = await Bun.connect({
          hostname: "127.0.0.1",
          port: 55432,
          socket: { data() {}, open() {}, close() {} },
        });
        socket.end();
      } finally {
        for (const service of Object.values(plan.services)) {
          await Effect.runPromise(
            Effect.either(
              liveRequest({
                method: "POST",
                path: `/containers/lando-${plan.slug}-${service.name}/stop`,
              }),
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
      }
    },
    // Real Podman create/start/inspect via curl-per-call easily exceeds Bun's
    // default 5s test timeout; allow enough headroom for image-resident MVP
    // services (Node + Postgres) plus stop/delete cleanup.
    60_000,
  );
});
