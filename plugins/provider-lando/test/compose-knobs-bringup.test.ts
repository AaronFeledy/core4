import { describe, expect, test } from "bun:test";
import { Cause, DateTime, Effect, Exit } from "effect";

import {
  type PodmanApiClient,
  type PodmanHttpRequest,
  type PodmanHttpResponse,
  bringUp,
} from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  PortablePath,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

const providerId = ProviderId.make("lando");
const appId = AppId.make("compose-knob-bringup");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-27T00:00:00Z"),
  source: "provider-lando/compose-knobs-bringup.test.ts",
  runtime: 4 as const,
};

const baseService: ServicePlan = {
  name: serviceName,
  type: "web",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
  environment: { APP_ENV: "test" },
  mounts: [
    {
      type: "bind",
      source: AbsolutePath.make("/tmp/lando-compose-knob-bind"),
      target: PortablePath.make("/workspace"),
      readOnly: false,
      realization: "passthrough",
    },
    {
      type: "bind",
      source: AbsolutePath.make("/tmp/lando-compose-knob-config"),
      target: PortablePath.make("/etc/config"),
      readOnly: true,
      realization: "passthrough",
      createHostPath: false,
    },
  ],
  storage: [],
  endpoints: [
    {
      _tag: "published",
      port: 8080,
      protocol: "http",
      name: "http",
      publication: { bindAddress: "127.0.0.1", hostPort: 18080 },
    },
  ],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const planWithCompose = (compose?: Record<string, unknown>): AppPlan => {
  const service: ServicePlan = {
    ...baseService,
    extensions: compose === undefined ? {} : { compose },
  };
  return {
    id: appId,
    name: "Compose Knob Bringup",
    slug: "compose-knob-bringup",
    root: AbsolutePath.make("/tmp/lando-compose-knob-bringup"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    networking: { perAppBridge: { name: "compose-knob-network", driver: "bridge" } },
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const makeFakeApi = () => {
  const calls: PodmanHttpRequest[] = [];
  const existing = new Set<string>();
  const running = new Set<string>();
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync((): PodmanHttpResponse => {
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
          return existing.has(name)
            ? { status: 200, body: JSON.stringify({ State: { Running: running.has(name) } }) }
            : { status: 404, body: "{}" };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          const createdName = new URL(`http://localhost${request.path}`).searchParams.get("name") ?? "";
          existing.add(createdName);
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && action === "start") {
          running.add(name);
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

const findCreateRequest = (calls: ReadonlyArray<PodmanHttpRequest>): PodmanHttpRequest | undefined =>
  calls.find((call) => call.method === "POST" && call.path.startsWith("/containers/create"));

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const hostConfig = (request: PodmanHttpRequest | undefined): unknown => field(request?.body, "HostConfig");

const BASELINE_CREATE_BODY_JSON =
  '{"name":"lando-compose-knob-bringup-web","Image":"nginx:1.27-alpine","Env":["APP_ENV=test"],"ExposedPorts":{"8080/tcp":{}},"Labels":{"dev.lando.app":"compose-knob-bringup","dev.lando.service":"web"},"HostConfig":{"PortBindings":{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"18080"}]},"Binds":["/tmp/lando-compose-knob-bind:/workspace"],"Mounts":[{"Type":"bind","Source":"/tmp/lando-compose-knob-config","Target":"/etc/config","ReadOnly":true,"BindOptions":{"CreateMountpoint":false}}]},"NetworkingConfig":{"EndpointsConfig":{"compose-knob-network":{"Aliases":["web"]}}}}';

describe("provider-lando Compose knob bring-up realization", () => {
  test("Given knobs and plan-derived networking, when creating a container, then HostConfig merges every source", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ privileged: true, cap_add: ["NET_ADMIN"] });

    // When
    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));

    // Then
    const host = hostConfig(findCreateRequest(fake.calls));
    expect(field(host, "Privileged")).toBe(true);
    expect(field(host, "CapAdd")).toEqual(["NET_ADMIN"]);
    expect(field(host, "PortBindings")).toEqual({
      "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "18080" }],
    });
    expect(field(host, "Binds")).toEqual(["/tmp/lando-compose-knob-bind:/workspace"]);
    expect(field(host, "Mounts")).toEqual([
      {
        Type: "bind",
        Source: "/tmp/lando-compose-knob-config",
        Target: "/etc/config",
        ReadOnly: true,
        BindOptions: { CreateMountpoint: false },
      },
    ]);
  });

  test("Given stop knobs, when creating a container, then they appear only at the top level", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ stop_signal: "SIGUSR1", stop_grace_period: 30 });

    // When
    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));

    // Then
    const create = findCreateRequest(fake.calls);
    expect(field(create?.body, "StopSignal")).toBe("SIGUSR1");
    expect(field(create?.body, "StopTimeout")).toBe(30);
    expect(field(hostConfig(create), "StopSignal")).toBeUndefined();
    expect(field(hostConfig(create), "StopTimeout")).toBeUndefined();
  });

  test("Given a platform knob, when creating a container, then query parameters preserve platform and name", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ platform: "linux/amd64" });

    // When
    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));

    // Then
    const create = findCreateRequest(fake.calls);
    const searchParams = new URL(`http://localhost${create?.path ?? ""}`).searchParams;
    expect(searchParams.get("name")).toBe("lando-compose-knob-bringup-web");
    expect(searchParams.get("platform")).toBe("linux/amd64");
  });

  test("Given tmpfs colliding with a Binds target, when bringing up, then creation fails with ServiceStartError", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ tmpfs: ["/workspace:size=64m"] });

    // When
    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    // Then
    const failures = Exit.isFailure(exit) ? Array.from(Cause.failures(exit.cause)) : [];
    expect(failures).toContainEqual(
      expect.objectContaining({ _tag: "ServiceStartError", operation: "bringUp.knobs", service: "web" }),
    );
    expect(findCreateRequest(fake.calls)).toBeUndefined();
  });

  test("Given tmpfs colliding with a Mounts target, when bringing up, then creation fails with ServiceStartError", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ tmpfs: ["/etc/config"] });

    // When
    const exit = await Effect.runPromiseExit(bringUp(plan, { podmanApi: fake.api }));

    // Then
    const failures = Exit.isFailure(exit) ? Array.from(Cause.failures(exit.cause)) : [];
    expect(failures).toContainEqual(
      expect.objectContaining({ _tag: "ServiceStartError", operation: "bringUp.knobs", service: "web" }),
    );
    expect(findCreateRequest(fake.calls)).toBeUndefined();
  });

  test("Given no plan-derived ExtraHosts, when extra_hosts is realized, then only knob entries are emitted", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ extra_hosts: { "api.local": ["10.0.0.1", "10.0.0.2"] } });

    // When
    await Effect.runPromise(bringUp(plan, { podmanApi: fake.api }));

    // Then
    expect(field(hostConfig(findCreateRequest(fake.calls)), "ExtraHosts")).toEqual([
      "api.local:10.0.0.1",
      "api.local:10.0.0.2",
    ]);
  });

  test("Given baseline fields and knobs, when both containers are created, then knobs do not clobber baseline fields", async () => {
    // Given
    const baselineFake = makeFakeApi();
    const knobsFake = makeFakeApi();

    // When
    await Effect.runPromise(bringUp(planWithCompose(), { podmanApi: baselineFake.api }));
    await Effect.runPromise(
      bringUp(planWithCompose({ privileged: true, platform: "linux/arm64" }), {
        podmanApi: knobsFake.api,
      }),
    );

    // Then
    const baseline = findCreateRequest(baselineFake.calls)?.body;
    const withKnobs = findCreateRequest(knobsFake.calls)?.body;
    expect({
      Env: field(withKnobs, "Env"),
      Labels: field(withKnobs, "Labels"),
      NetworkingConfig: field(withKnobs, "NetworkingConfig"),
      PortBindings: field(field(withKnobs, "HostConfig"), "PortBindings"),
      Binds: field(field(withKnobs, "HostConfig"), "Binds"),
      Mounts: field(field(withKnobs, "HostConfig"), "Mounts"),
    }).toEqual({
      Env: field(baseline, "Env"),
      Labels: field(baseline, "Labels"),
      NetworkingConfig: field(baseline, "NetworkingConfig"),
      PortBindings: field(field(baseline, "HostConfig"), "PortBindings"),
      Binds: field(field(baseline, "HostConfig"), "Binds"),
      Mounts: field(field(baseline, "HostConfig"), "Mounts"),
    });
  });

  test("Given no Compose extension, when creating a container, then the request is byte-identical to the baseline", async () => {
    // Given
    const fake = makeFakeApi();

    // When
    await Effect.runPromise(bringUp(planWithCompose(), { podmanApi: fake.api }));

    // Then
    const create = findCreateRequest(fake.calls);
    expect(create?.path).toBe("/containers/create?name=lando-compose-knob-bringup-web");
    expect(JSON.stringify(create?.body)).toBe(BASELINE_CREATE_BODY_JSON);
  });
});
