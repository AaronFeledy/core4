import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { EngineHttpRequest, EngineHttpResponse, PodmanApiClient } from "../src/engine-api.ts";
import { bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const appId = AppId.make("recreate-ports");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-09-01T00:00:00Z"),
  source: "container-runtime/bring-up-recreate.test.ts",
  runtime: 4 as const,
};
const containerName = "lando-recreate-ports-web";

const planWithHostPort = (hostPort: number): AppPlan => {
  const service: ServicePlan = {
    name: serviceName,
    type: "web",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [
      {
        _tag: "published",
        port: 8080,
        protocol: "http",
        name: "http",
        publication: { bindAddress: "127.0.0.1", hostPort },
      },
    ],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: {},
  };
  return {
    id: appId,
    name: "Recreate Ports",
    slug: "recreate-ports",
    root: AbsolutePath.make("/tmp/lando-recreate-ports"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    networking: { perAppBridge: { name: "recreate-ports-network", driver: "bridge" } },
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const inspectBody = (
  hostPort: string,
  running: boolean,
  bindSource?: string,
  networks?: ReadonlyArray<string>,
): string =>
  JSON.stringify({
    State: { Running: running },
    ...(networks === undefined
      ? {}
      : { NetworkSettings: { Networks: Object.fromEntries(networks.map((name) => [name, {}])) } }),
    ...(bindSource === undefined
      ? {}
      : {
          Mounts:
            bindSource === ""
              ? []
              : [{ Type: "bind", Source: bindSource, Destination: "/run/lando/host-proxy.sock" }],
        }),
    HostConfig: {
      PortBindings: {
        "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }],
      },
    },
  });

const inspectWithoutPortBindings = (running: boolean): string =>
  JSON.stringify({ State: { Running: running } });

const makeFakeApi = (input: {
  readonly deleteStatus: number;
  readonly omitPortBindings?: boolean;
  readonly existingBindSource?: string;
  readonly existingContainerName?: string;
  readonly existingNetworks?: ReadonlyArray<string>;
  readonly agentMount?: {
    readonly Type: string;
    readonly Source: string;
    readonly Name?: string;
    readonly Destination: string;
  };
}) => {
  const calls: EngineHttpRequest[] = [];
  let exists = true;
  let running = true;
  let hostPort = "18080";
  let bindSource = input.existingBindSource;
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): EngineHttpResponse => {
        calls.push(request);
        const containerMatch = request.path.match(/^\/containers\/([^/?]+)(?:\/([^?]+))?/u);
        const name = containerMatch === null ? "" : decodeURIComponent(containerMatch[1] ?? "");
        const action = containerMatch?.[2];
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path === "/networks/create") {
          return { status: 201, body: "{}" };
        }
        if (request.method === "GET" && action === "json") {
          if (!exists) return { status: 404, body: "{}" };
          const body =
            input.omitPortBindings === true
              ? inspectWithoutPortBindings(running)
              : inspectBody(hostPort, running, bindSource, input.existingNetworks);
          return {
            status: 200,
            body:
              input.agentMount === undefined
                ? body
                : JSON.stringify({ ...JSON.parse(body), Mounts: [input.agentMount] }),
          };
        }
        if (request.method === "POST" && action === "stop") {
          running = false;
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && name === (input.existingContainerName ?? containerName)) {
          if (input.deleteStatus === 204) {
            exists = false;
            running = false;
          }
          return { status: input.deleteStatus, body: input.deleteStatus === 204 ? "" : "busy" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          if (exists) return { status: 409, body: "already exists" };
          exists = true;
          hostPort = "38080";
          bindSource = "/home/user/new/host-proxy.sock";
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          running = true;
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && request.path.startsWith("/networks/")) {
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };
  return { api, calls };
};

const createCalls = (calls: ReadonlyArray<EngineHttpRequest>): ReadonlyArray<EngineHttpRequest> =>
  calls.filter((call) => call.method === "POST" && call.path.startsWith("/containers/create"));

describe("Podman publish-port recreate", () => {
  test.each([
    ["bind", "/old/agent", "bind", "/new/agent", true],
    ["bind", "/same/agent", "bind", "/same/agent", false],
    ["bind", "agent-volume", "volume", "agent-volume", true],
    ["volume", "old-volume", "volume", "new-volume", true],
    ["volume", "same-volume", "volume", "same-volume", false],
    ["bind", "/old/agent", undefined, undefined, true],
  ] as const)("SSH overlay recreation: %s %s to %s %s", async (oldType, oldSource, type, source, changed) => {
    // Given
    const target = PortablePath.make("/run/lando/ssh-agent");
    const fake = makeFakeApi({
      deleteStatus: 204,
      agentMount: {
        Type: oldType,
        Source: oldType === "volume" ? `/var/lib/volumes/${oldSource}/_data` : oldSource,
        ...(oldType === "volume" ? { Name: oldSource } : {}),
        Destination: target,
      },
    });
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          mounts:
            type === undefined
              ? []
              : [{ type, source, target, readOnly: true, realization: "passthrough" as const }],
        },
      },
    };
    // When
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    // Then
    expect(result.changed).toBe(changed);
    expect(createCalls(fake.calls)).toHaveLength(changed ? 1 : 0);
  });
  test("recreates an existing container that is missing the planned physical network", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingNetworks: ["lando-shared"],
    });
    const base = planWithHostPort(18080);
    const plan: AppPlan = {
      ...base,
      networking: {
        perAppBridge: {
          name: "lando-vm-0123456789ab-fedcba987654",
          driver: "bridge",
        },
      },
    };

    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/containers/"))).toBe(
      true,
    );
  });

  test("keeps an existing container already attached to its planned network", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingNetworks: ["recreate-ports-network"],
    });

    const result = await Effect.runPromise(bringUp(planWithHostPort(18080), { api: fake.api, ctx }));

    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(0);
  });

  test.each([true, false])(
    "recreates an existing running container without PortBindings only when reconcile=%s",
    async (reconcile) => {
      // Given
      const fake = makeFakeApi({ deleteStatus: 204, omitPortBindings: true });
      const plan = planWithHostPort(38080);

      // When
      const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, reconcile }));

      // Then
      expect(result.changed).toBe(reconcile);
      expect(createCalls(fake.calls)).toHaveLength(reconcile ? 1 : 0);
    },
  );

  test("Given a fingerprint mismatch and a failed remove, When bringing up, Then start fails instead of keeping old PortBindings", async () => {
    // Given: existing container still publishes 18080; planned host port is 38080; DELETE is rejected.
    const fake = makeFakeApi({ deleteStatus: 409 });
    const plan = planWithHostPort(38080);

    // When
    const exit = await Effect.runPromiseExit(bringUp(plan, { api: fake.api, ctx }));

    // Then: recreate must not treat 409-create as success on the leftover container.
    const failures = Exit.isFailure(exit) ? Array.from(Cause.failures(exit.cause)) : [];
    expect(failures).toContainEqual(
      expect.objectContaining({ _tag: "ServiceStartError", operation: "bringUp.remove", service: "web" }),
    );
    expect(createCalls(fake.calls)).toEqual([]);
  });

  test("Given a fingerprint mismatch and a successful remove, When bringing up, Then the container is recreated", async () => {
    // Given
    const fake = makeFakeApi({ deleteStatus: 204 });
    const plan = planWithHostPort(38080);

    // When
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    // Then
    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
  });

  test("recreates an existing stopped container when a bind source changes", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingBindSource: "/home/user/old/host-proxy.sock",
    });
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          environment: { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
          mounts: [
            {
              type: "bind",
              source: "/home/user/new/host-proxy.sock",
              target: PortablePath.make("/run/lando/host-proxy.sock"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };

    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(true);
    expect(createCalls(fake.calls)).toHaveLength(1);
    expect(fake.calls.some((call) => call.method === "DELETE" && call.path.startsWith("/containers/"))).toBe(
      true,
    );
    expect(
      fake.calls.find((call) => call.method === "POST" && call.path.startsWith("/containers/create"))?.body,
    ).toMatchObject({
      HostConfig: { Binds: ["/home/user/new/host-proxy.sock:/run/lando/host-proxy.sock:ro"] },
    });
  });

  for (const [label, existingBindSource] of [
    ["missing metadata", undefined],
    ["empty mount list", ""],
  ] as const) {
    test(`recreates a container when its socket mount has ${label}`, async () => {
      const fake = makeFakeApi({
        deleteStatus: 204,
        ...(existingBindSource === undefined ? {} : { existingBindSource }),
      });
      const base = planWithHostPort(18080);
      const service = base.services[serviceName];
      if (service === undefined) throw new Error("Test service is missing.");
      const plan: AppPlan = {
        ...base,
        services: {
          [serviceName]: {
            ...service,
            environment: { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
            mounts: [
              {
                type: "bind",
                source: "/home/user/new/host-proxy.sock",
                target: PortablePath.make("/run/lando/host-proxy.sock"),
                readOnly: true,
                realization: "passthrough",
              },
            ],
          },
        },
      };
      const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
      expect(result.changed).toBe(true);
      expect(createCalls(fake.calls)).toHaveLength(1);
    });
  }

  test("does not compare unrelated bind sources without a host-proxy session", async () => {
    const fake = makeFakeApi({ deleteStatus: 204, existingBindSource: "/home/user/old/host-proxy.sock" });
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          mounts: [
            {
              type: "bind",
              source: "/home/user/new/host-proxy.sock",
              target: PortablePath.make("/run/lando/host-proxy.sock"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };
    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(0);
  });
  test("reuses an existing container when its bind source is unchanged", async () => {
    const fake = makeFakeApi({
      deleteStatus: 204,
      existingBindSource: "/home/user/new/host-proxy.sock",
    });
    const base = planWithHostPort(18080);
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          environment: { LANDO_HOST_PROXY_SOCKET: "/run/lando/host-proxy.sock" },
          mounts: [
            {
              type: "bind",
              source: "/home/user/new/host-proxy.sock",
              target: PortablePath.make("/run/lando/host-proxy.sock"),
              readOnly: true,
              realization: "passthrough",
            },
          ],
        },
      },
    };

    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(false);
    expect(createCalls(fake.calls)).toHaveLength(0);
  });
  test("recreates a global published service on only the shared network", async () => {
    const fake = makeFakeApi({ deleteStatus: 204, existingContainerName: "lando-global-web" });
    const plan: AppPlan = {
      ...planWithHostPort(38080),
      id: AppId.make("global"),
      name: "Global",
      slug: "global",
      networking: {
        perAppBridge: { name: "lando-global", driver: "bridge" },
        sharedNetworkMembership: {
          name: "lando_bridge_network",
          aliases: { [ServiceName.make("web")]: ["web.global.internal"] },
        },
      },
    };

    const result = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    expect(result.changed).toBe(true);
    const createdNetworks = fake.calls
      .filter((call) => call.method === "POST" && call.path === "/networks/create")
      .map((call) => Reflect.get(call.body as object, "Name"));
    expect(createdNetworks).toEqual(["lando_bridge_network"]);
    const created = createCalls(fake.calls);
    expect(created).toHaveLength(1);
    expect(created[0]?.body).toMatchObject({
      NetworkingConfig: {
        EndpointsConfig: {
          lando_bridge_network: { Aliases: ["web.global.internal"] },
        },
      },
    });
  });
  test("Given inspect without PortBindings, When bringing up a pinned hostPort plan, Then the running container is not recreated", async () => {
    // Given: fake inspect returns State.Running only; planned hostPort is pinned.
    const fake = makeFakeApi({ deleteStatus: 204, omitPortBindings: true });
    const plan = planWithHostPort(38080);

    // When
    const first = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));
    const second = await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    // Then: unknown inspect fingerprint is not a proven mismatch.
    expect(first.changed).toBe(false);
    expect(second.changed).toBe(false);
    expect(createCalls(fake.calls)).toEqual([]);
  });
});
