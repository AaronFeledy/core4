import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type EndpointPublication,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import type { EngineHttpRequest, EngineHttpResponse, PodmanApiClient } from "../src/engine-api.ts";
import { bringUp } from "../src/podman/bring-up.ts";
import { SERVICE_PUBLISH_PORT_MIN, type ServicePublishProbe } from "../src/service-publish-ports.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry." } as const;
const appId = AppId.make("publish-ports");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-09-01T00:00:00Z"),
  source: "container-runtime/bring-up-publish-ports.test.ts",
  runtime: 4 as const,
};
const containerName = "lando-publish-ports-web";

const planWithPublication = (publication: EndpointPublication): AppPlan => {
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
        publication,
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
    name: "Publish Ports",
    slug: "publish-ports",
    root: AbsolutePath.make("/tmp/lando-publish-ports"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    networking: { perAppBridge: { name: "publish-ports-network", driver: "bridge" } },
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const inspectBody = (hostPort: string, running: boolean): string =>
  JSON.stringify({
    State: { Running: running },
    NetworkSettings: { Ports: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] } },
    HostConfig: { PortBindings: { "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: hostPort }] } },
  });

const makeFakeApi = (input: {
  readonly exists?: boolean;
  readonly running?: boolean;
  readonly inspectHostPort?: string;
  readonly createStatuses?: ReadonlyArray<number>;
  readonly createBodies?: ReadonlyArray<string>;
  readonly existingBindSource?: string;
}) => {
  const calls: EngineHttpRequest[] = [];
  let exists = input.exists ?? false;
  let running = input.running ?? exists;
  let hostPort = input.inspectHostPort ?? "31234";
  let createIndex = 0;
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
          const body = JSON.parse(inspectBody(hostPort, running)) as Record<string, unknown>;
          if (input.existingBindSource !== undefined) {
            body.Mounts = [
              { Type: "bind", Source: input.existingBindSource, Destination: "/run/lando/host-proxy.sock" },
            ];
          }
          return { status: 200, body: JSON.stringify(body) };
        }
        if (request.method === "POST" && action === "stop") {
          running = false;
          return { status: 204, body: "" };
        }
        if (request.method === "DELETE" && name === containerName) {
          exists = false;
          running = false;
          return { status: 204, body: "" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const status = input.createStatuses?.[createIndex] ?? 201;
          const body = input.createBodies?.[createIndex] ?? "{}";
          createIndex += 1;
          if (status === 201 || status === 409) {
            exists = true;
            const created = request.body as { HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }>> } };
            hostPort = created.HostConfig?.PortBindings?.["8080/tcp"]?.[0]?.HostPort || hostPort;
          }
          return { status, body };
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

const createHostPort = (calls: ReadonlyArray<EngineHttpRequest>, index = 0): string | undefined => {
  const created = createCalls(calls)[index]?.body as
    | { HostConfig?: { PortBindings?: Record<string, Array<{ HostPort?: string }>> } }
    | undefined;
  return (
    created?.HostConfig?.PortBindings?.["8080/tcp"]?.[0]?.HostPort ??
    created?.HostConfig?.PortBindings?.["8080/udp"]?.[0]?.HostPort
  );
};

const successProbe: ServicePublishProbe = (_host, port) =>
  Effect.succeed(port === SERVICE_PUBLISH_PORT_MIN ? { kind: "success" } : { kind: "EADDRINUSE", code: "EADDRINUSE" });

describe("create-body service publish ports", () => {
  test("omitted hostPort is never written into desired state", async () => {
    const fake = makeFakeApi({ exists: false });
    const plan = planWithPublication({ bindAddress: "127.0.0.1" });
    const before = plan.services[serviceName]?.endpoints[0];

    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, platform: "linux", probeBind: successProbe }));

    expect(plan.services[serviceName]?.endpoints[0]).toEqual(before);
    expect(plan.services[serviceName]?.endpoints[0]).toMatchObject({ publication: { bindAddress: "127.0.0.1" } });
    expect("hostPort" in (plan.services[serviceName]?.endpoints[0] as { publication: object }).publication).toBe(
      false,
    );
    expect(createHostPort(fake.calls)).toBe(String(SERVICE_PUBLISH_PORT_MIN));
  });

  test("a non-port recreate copies the inspected HostPort onto the create body only", async () => {
    const fake = makeFakeApi({
      exists: true,
      running: true,
      inspectHostPort: "31234",
      existingBindSource: "/home/user/old/host-proxy.sock",
    });
    const base = planWithPublication({ bindAddress: "127.0.0.1" });
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

    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, platform: "linux", probeBind: successProbe }));

    expect(createHostPort(fake.calls)).toBe("31234");
    expect(plan.services[serviceName]?.endpoints[0]).toMatchObject({ publication: { bindAddress: "127.0.0.1" } });
    expect("hostPort" in (plan.services[serviceName]?.endpoints[0] as { publication: object }).publication).toBe(
      false,
    );
  });

  test("an explicit hostPort is untouched", async () => {
    const fake = makeFakeApi({
      exists: true,
      running: true,
      inspectHostPort: "31234",
      existingBindSource: "/home/user/old/host-proxy.sock",
    });
    const base = planWithPublication({ bindAddress: "127.0.0.1", hostPort: 18_080 });
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

    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, platform: "linux", probeBind: successProbe }));

    expect(createHostPort(fake.calls)).toBe("18080");
    expect(plan.services[serviceName]?.endpoints[0]).toMatchObject({
      publication: { bindAddress: "127.0.0.1", hostPort: 18_080 },
    });
  });

  test("a fingerprint mismatch does not copy", async () => {
    const fake = makeFakeApi({ exists: true, running: true, inspectHostPort: "18080" });
    const plan = planWithPublication({ bindAddress: "127.0.0.1", hostPort: 38_080 });

    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, platform: "linux", probeBind: successProbe }));

    expect(createHostPort(fake.calls)).toBe("38080");
  });

  test("first create probes the named service-publish band", async () => {
    const calls: Array<{ host: string; port: number; protocol: "tcp" | "udp" }> = [];
    const probeBind: ServicePublishProbe = (host, port, protocol) => {
      calls.push({ host, port, protocol });
      return Effect.succeed({ kind: "success" });
    };
    const fake = makeFakeApi({ exists: false });
    const plan = planWithPublication({ bindAddress: "127.0.0.1" });

    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, platform: "linux", probeBind }));

    expect(calls[0]).toEqual({ host: "127.0.0.1", port: SERVICE_PUBLISH_PORT_MIN, protocol: "tcp" });
    expect(createHostPort(fake.calls)).toBe(String(SERVICE_PUBLISH_PORT_MIN));
  });

  test("EACCES does not walk the band", async () => {
    const calls: Array<number> = [];
    const probeBind: ServicePublishProbe = (_host, port) => {
      calls.push(port);
      return Effect.succeed({ kind: "EACCES", code: "EACCES" });
    };
    const fake = makeFakeApi({ exists: false });

    await Effect.runPromise(
      bringUp(planWithPublication({}), { api: fake.api, ctx, platform: "linux", probeBind }),
    );

    expect(calls).toEqual([SERVICE_PUBLISH_PORT_MIN]);
    expect(createHostPort(fake.calls)).toBe(String(SERVICE_PUBLISH_PORT_MIN));
  });

  test("a TCP probe does not satisfy udp", async () => {
    const calls: Array<"tcp" | "udp"> = [];
    const probeBind: ServicePublishProbe = (_host, port, protocol) => {
      calls.push(protocol);
      if (protocol === "tcp") return Effect.succeed({ kind: "success" });
      if (port === SERVICE_PUBLISH_PORT_MIN) return Effect.succeed({ kind: "EADDRINUSE", code: "EADDRINUSE" });
      return Effect.succeed({ kind: "success" });
    };
    const fake = makeFakeApi({ exists: false });
    const base = planWithPublication({});
    const service = base.services[serviceName];
    if (service === undefined) throw new Error("Test service is missing.");
    const plan: AppPlan = {
      ...base,
      services: {
        [serviceName]: {
          ...service,
          endpoints: [{ _tag: "published", port: 8080, protocol: "udp", publication: {} }],
        },
      },
    };

    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, platform: "linux", probeBind }));

    expect(calls.every((protocol) => protocol === "udp")).toBe(true);
    expect(createHostPort(fake.calls)).toBe(String(SERVICE_PUBLISH_PORT_MIN + 1));
  });

  test.each([
    ["remote URL", { platform: "linux" as const, daemonUrl: "tcp://127.0.0.1:2375" }],
    ["VM-mediated Docker", { platform: "darwin" as const, daemonUrl: "/var/run/docker.sock" }],
    ["win32 guest", { platform: "win32" as const, daemonUrl: "npipe://./pipe/docker_engine" }],
  ])("%s skips the probe", async (_label, host) => {
    const calls: Array<number> = [];
    const probeBind: ServicePublishProbe = (_host, port) => {
      calls.push(port);
      return Effect.succeed({ kind: "success" });
    };
    const fake = makeFakeApi({ exists: false });

    await Effect.runPromise(bringUp(planWithPublication({}), { api: fake.api, ctx, probeBind, ...host }));

    expect(calls).toEqual([]);
    expect(createHostPort(fake.calls)).toBe("");
  });

  test("a daemon bind rejection retries once", async () => {
    const ports: Array<number> = [];
    const probeBind: ServicePublishProbe = (_host, port) => {
      ports.push(port);
      return Effect.succeed({ kind: "success" });
    };
    const fake = makeFakeApi({
      exists: false,
      createStatuses: [500, 201],
      createBodies: ["address already in use", "{}"],
    });

    await Effect.runPromise(
      bringUp(planWithPublication({}), { api: fake.api, ctx, platform: "linux", probeBind }),
    );

    expect(createCalls(fake.calls)).toHaveLength(2);
    expect(createHostPort(fake.calls, 0)).toBe(String(SERVICE_PUBLISH_PORT_MIN));
    expect(createHostPort(fake.calls, 1)).toBe(String(SERVICE_PUBLISH_PORT_MIN + 1));
    expect(ports[0]).toBe(SERVICE_PUBLISH_PORT_MIN);
    expect(ports).toContain(SERVICE_PUBLISH_PORT_MIN + 1);
  });
});
