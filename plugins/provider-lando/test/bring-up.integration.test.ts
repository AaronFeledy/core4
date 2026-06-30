import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import { bringUp, makePodmanApiClient, makeProviderLayer } from "@lando/provider-lando";
import type { ServiceStartError } from "@lando/sdk/errors";
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
  fileSync: [],
  metadata,
  extensions: {},
};

interface CreateContainerBody {
  readonly Cmd?: ReadonlyArray<string>;
  readonly HostConfig?: {
    readonly Binds?: ReadonlyArray<string>;
  };
  readonly NetworkingConfig?: {
    readonly EndpointsConfig?: Readonly<Record<string, { readonly Aliases?: ReadonlyArray<string> }>>;
  };
}

interface FakeApiHooks {
  readonly failStartFor?: ReadonlySet<string>;
  readonly failCreateFor?: ReadonlySet<string>;
  readonly startFailureBody?: string;
}

const makeFakeApi = (hooks: FakeApiHooks = {}) => {
  const running = new Set<string>();
  const existing = new Set<string>();
  const networks = new Set<string>();
  const volumes = new Set<string>();
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
        if (request.path === "/volumes/create") {
          const requestedName = (request.body as { Name?: string }).Name ?? "";
          const existed = volumes.has(requestedName);
          volumes.add(requestedName);
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
          if (hooks.failCreateFor?.has(createdName) === true) {
            return {
              status: 500,
              body: `forced create failure for ${createdName}: env POSTGRES_PASSWORD=hunter2 rejected`,
            };
          }
          if (existing.has(createdName)) {
            return { status: 409, body: "already exists" };
          }
          existing.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          if (hooks.failStartFor?.has(name) === true) {
            return {
              status: 500,
              body: hooks.startFailureBody ?? `forced start failure for ${name}`,
            };
          }
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
        if (request.method === "DELETE" && request.path.startsWith("/containers/")) {
          const deleted = existing.delete(name);
          running.delete(name);
          return { status: deleted ? 204 : 404, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls, running, existing, networks, volumes };
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
    expect(nodeCreateBody?.NetworkingConfig?.EndpointsConfig).toEqual({
      "lando-bringupapp": {},
      lando_bridge_network: { Aliases: ["node.bringupapp.internal"] },
    });
    expect(
      fake.calls
        .filter((call) => call.path === "/networks/create")
        .slice(0, 2)
        .map((call) => call.body),
    ).toEqual([
      { Name: "lando-bringupapp", Driver: "bridge" },
      { Name: "lando_bridge_network", Driver: "bridge" },
    ]);
  });

  test("uses typed NetworkingPlan names and aliases when creating containers", async () => {
    const fake = makeFakeApi();
    const customPlan: AppPlan = {
      ...plan,
      networking: {
        perAppBridge: { name: "custom-app-net", driver: "bridge" },
        sharedNetworkMembership: {
          name: "custom-shared-net",
          aliases: { [node.name]: ["node.custom.internal"] },
        },
      },
    };

    await Effect.runPromise(bringUp(customPlan, { podmanApi: fake.api }));

    const nodeCreate = fake.calls.find(
      (call) =>
        call.method === "POST" &&
        call.path.startsWith("/containers/create") &&
        new URL(`http://localhost${call.path}`).searchParams.get("name") === "lando-bringupapp-node",
    );
    const nodeCreateBody = nodeCreate?.body as CreateContainerBody | undefined;
    expect(nodeCreateBody?.NetworkingConfig?.EndpointsConfig).toEqual({
      "custom-app-net": {},
      "custom-shared-net": { Aliases: ["node.custom.internal"] },
    });
    expect(
      fake.calls
        .filter((call) => call.path === "/networks/create")
        .slice(0, 2)
        .map((call) => call.body),
    ).toEqual([
      { Name: "custom-app-net", Driver: "bridge" },
      { Name: "custom-shared-net", Driver: "bridge" },
    ]);
  });

  test("creates and mounts cache volumes with storage-kind labels", async () => {
    const fake = makeFakeApi();
    const cacheService: ServicePlan = {
      ...node,
      storage: [{ store: "lando-cache-npm", target: PortablePath.make("/home/node/.npm"), readOnly: false }],
    };
    const cachePlan: AppPlan = {
      ...plan,
      services: { [database.name]: database, [cacheService.name]: cacheService },
      stores: [{ name: "lando-cache-npm", scope: "global", kind: "cache", key: "npm" }],
    };

    await Effect.runPromise(bringUp(cachePlan, { podmanApi: fake.api }));

    const volumeCreate = fake.calls.find((call) => call.method === "POST" && call.path === "/volumes/create");
    expect(volumeCreate?.body).toEqual({
      Name: "lando-cache-npm",
      Labels: {
        "dev.lando.app": appId,
        "dev.lando.scope": "global",
        "dev.lando.storage-kind": "cache",
        "dev.lando.store": "lando-cache-npm",
      },
    });
    const nodeCreate = fake.calls.find(
      (call) =>
        call.method === "POST" &&
        call.path.startsWith("/containers/create") &&
        new URL(`http://localhost${call.path}`).searchParams.get("name") === "lando-bringupapp-node",
    );
    const nodeCreateBody = nodeCreate?.body as CreateContainerBody | undefined;
    expect(nodeCreateBody?.HostConfig?.Binds).toContain("lando-cache-npm:/home/node/.npm");
  });

  test("omits shared Podman network membership when typed shared membership is absent", async () => {
    const fake = makeFakeApi();
    const perAppOnlyPlan: AppPlan = {
      ...plan,
      networking: { perAppBridge: { name: "custom-app-only", driver: "bridge" } },
    };

    await Effect.runPromise(bringUp(perAppOnlyPlan, { podmanApi: fake.api }));

    const nodeCreate = fake.calls.find(
      (call) =>
        call.method === "POST" &&
        call.path.startsWith("/containers/create") &&
        new URL(`http://localhost${call.path}`).searchParams.get("name") === "lando-bringupapp-node",
    );
    const nodeCreateBody = nodeCreate?.body as CreateContainerBody | undefined;
    expect(nodeCreateBody?.NetworkingConfig?.EndpointsConfig).toEqual({ "custom-app-only": {} });
    expect(
      fake.calls
        .filter((call) => call.path === "/networks/create")
        .slice(0, 1)
        .map((call) => call.body),
    ).toEqual([{ Name: "custom-app-only", Driver: "bridge" }]);
  });

  test("realizes accelerated appMount and bind mounts as file-sync volumes", async () => {
    const fake = makeFakeApi();
    const acceleratedAppRoot = AbsolutePath.make("/tmp/lando-accel-app");
    const acceleratedNode: ServicePlan = {
      ...node,
      dependsOn: [],
      appMount: {
        source: acceleratedAppRoot,
        target: PortablePath.make("/app"),
        readOnly: false,
        excludes: [],
        includes: [],
        realization: "accelerated",
      },
      mounts: [
        {
          type: "bind",
          source: AbsolutePath.make("/tmp/lando-accel-cache"),
          target: PortablePath.make("/cache"),
          readOnly: true,
          realization: "accelerated",
        },
      ],
    };
    const acceleratedPlan: AppPlan = {
      ...plan,
      services: { [acceleratedNode.name]: acceleratedNode },
      stores: [],
    };

    await Effect.runPromise(bringUp(acceleratedPlan, { podmanApi: fake.api }));

    const create = fake.calls.find(
      (call) => call.method === "POST" && call.path.startsWith("/containers/create"),
    );
    const body = create?.body as CreateContainerBody | undefined;
    expect(body?.HostConfig?.Binds).toEqual([
      "BringUp-App-node-app-mount:/app",
      "BringUp-App-node-mount-0:/cache:ro",
    ]);
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
    expect(fake.networks.size).toBe(0);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/networks/"))).toBe(
      true,
    );
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

  test("rolls back containers and network when the first service start fails after network create", async () => {
    const fake = makeFakeApi({ failStartFor: new Set(["lando-bringupapp-database"]) });

    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.existing.size).toBe(0);
    expect(fake.networks.size).toBe(0);
    expect(
      fake.calls.some(
        (call) => call.method === "DELETE" && call.path.startsWith("/containers/lando-bringupapp-database"),
      ),
    ).toBe(true);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/networks/"))).toBe(
      true,
    );
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      false,
    );
  });

  test("rolls back the first service and network when the second service start fails", async () => {
    const fake = makeFakeApi({ failStartFor: new Set(["lando-bringupapp-node"]) });

    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    expect(Exit.isFailure(exit)).toBe(true);
    expect(fake.existing.size).toBe(0);
    expect(fake.running.size).toBe(0);
    expect(fake.networks.size).toBe(0);
    const databaseDeleted = fake.calls.some(
      (call) => call.method === "DELETE" && call.path.startsWith("/containers/lando-bringupapp-database"),
    );
    const nodeDeleted = fake.calls.some(
      (call) => call.method === "DELETE" && call.path.startsWith("/containers/lando-bringupapp-node"),
    );
    expect(databaseDeleted).toBe(true);
    expect(nodeDeleted).toBe(true);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/volumes/"))).toBe(
      false,
    );
  });

  test("failure errors include providerId, operation, redacted details, remediation, and cause", async () => {
    const fake = makeFakeApi({ failStartFor: new Set(["lando-bringupapp-database"]) });

    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const failures = Array.from(Cause.failures(exit.cause));
    const startError = failures.find(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag: string })._tag === "ServiceStartError",
    ) as ServiceStartError | undefined;
    expect(startError).toBeDefined();
    if (startError === undefined) return;
    expect(startError.providerId).toBe("lando");
    expect(startError.operation).toBe("bringUp.start");
    expect(startError.service).toBe("database");
    expect(typeof startError.message).toBe("string");
    expect(startError.remediation).toMatch(/lando destroy/u);
    expect(startError.details).toEqual({
      status: 500,
      body: "forced start failure for lando-bringupapp-database",
    });
  });

  test("surfaces the Podman API failure reason in the error message", async () => {
    const fake = makeFakeApi({
      failStartFor: new Set(["lando-bringupapp-database"]),
      startFailureBody: JSON.stringify({
        cause: "bind: permission denied",
        message:
          "rootlessport cannot expose privileged port 80, you can add 'net.ipv4.ip_unprivileged_port_start=80' to /etc/sysctl.conf (currently 1024); APP_SECRET=hunter2",
        response: 500,
      }),
    });

    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const startError = Array.from(Cause.failures(exit.cause)).find(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag: string })._tag === "ServiceStartError",
    ) as ServiceStartError | undefined;
    expect(startError).toBeDefined();
    if (startError === undefined) return;
    expect(startError.message).toContain("Podman container start failed with HTTP 500.");
    expect(startError.message).toContain("rootlessport cannot expose privileged port 80");
    expect(startError.message).toContain("net.ipv4.ip_unprivileged_port_start=80");
    expect(startError.message).not.toContain("hunter2");
    expect(startError.message).toContain("APP_SECRET=[redacted]");
  });

  test("keeps the base message when the Podman failure body is not JSON", async () => {
    const fake = makeFakeApi({ failStartFor: new Set(["lando-bringupapp-database"]) });

    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const startError = Array.from(Cause.failures(exit.cause)).find(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag: string })._tag === "ServiceStartError",
    ) as ServiceStartError | undefined;
    expect(startError).toBeDefined();
    if (startError === undefined) return;
    expect(startError.message).toBe("Podman container start failed with HTTP 500.");
  });

  test("redacts credential-like env values in error details", async () => {
    const fake = makeFakeApi({ failCreateFor: new Set(["lando-bringupapp-database"]) });

    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    expect(Exit.isFailure(exit)).toBe(true);
    if (!Exit.isFailure(exit)) return;
    const failures = Array.from(Cause.failures(exit.cause));
    const startError = failures.find(
      (error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error as { _tag: string })._tag === "ServiceStartError",
    ) as ServiceStartError | undefined;
    expect(startError).toBeDefined();
    if (startError === undefined) return;
    expect(startError.operation).toBe("bringUp.create");
    expect(startError.service).toBe("database");
    const details = startError.details as { status: number; body: string } | undefined;
    expect(details?.status).toBe(500);
    expect(details?.body).toContain("[redacted]");
    expect(details?.body).not.toContain("hunter2");
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

  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "brings up Node and Postgres services against a live Podman socket",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
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
    // default 5s test timeout; allow enough headroom for image-resident
    // services (Node + Postgres) plus stop/delete cleanup.
    60_000,
  );
});
