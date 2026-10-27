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
import { CREATE_CONFIG_LABEL } from "../src/create-fingerprint.ts";
import type { EngineHttpRequest, EngineHttpResponse, PodmanApiClient } from "../src/engine-api.ts";
import { bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry.", env: {} } as const;
const appId = AppId.make("compose-knob-bringup");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-07-27T00:00:00Z"),
  source: "container-runtime/compose-knobs-bringup.test.ts",
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

const planWithCompose = (
  compose?: Record<string, unknown>,
  hostAliases: ServicePlan["hostAliases"] = [],
): AppPlan => {
  const service: ServicePlan = {
    ...baseService,
    hostAliases,
    extensions: compose === undefined ? {} : { compose },
  };
  return {
    id: appId,
    valueModel: 1,
    name: "Compose Knob Bringup",
    slug: "compose-knob-bringup",
    root: AbsolutePath.make("/tmp/lando-compose-knob-bringup"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networking: { perAppBridge: { name: "compose-knob-network", driver: "bridge" } },
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const makeFakeApi = () => {
  const calls: EngineHttpRequest[] = [];
  const existing = new Set<string>();
  const running = new Set<string>();
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
        if (
          request.method === "POST" &&
          ["/networks/create", "/libpod/networks/create"].includes(request.path)
        ) {
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

const findCreateRequest = (calls: ReadonlyArray<EngineHttpRequest>): EngineHttpRequest | undefined =>
  calls.find((call) => call.method === "POST" && call.path.startsWith("/containers/create"));

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

const hostConfig = (request: EngineHttpRequest | undefined): unknown => field(request?.body, "HostConfig");

const BASELINE_CREATE_BODY_JSON =
  '{"name":"lando-compose-knob-bringup-web","Image":"nginx:1.27-alpine","Env":["APP_ENV=test"],"ExposedPorts":{"8080/tcp":{}},"Labels":{"dev.lando.app":"compose-knob-bringup","dev.lando.app-root":"/tmp/lando-compose-knob-bringup","dev.lando.service":"web","dev.lando.create-config":"v3:757a3980dbf3238decc59e55a30c10294773d4e432d40a99d2c1334235c6f65a"},"HostConfig":{"PortBindings":{"8080/tcp":[{"HostIp":"127.0.0.1","HostPort":"18080"}]},"Binds":["/tmp/lando-compose-knob-bind:/workspace"],"Mounts":[{"Type":"bind","Source":"/tmp/lando-compose-knob-config","Target":"/etc/config","ReadOnly":true,"BindOptions":{"CreateMountpoint":false}}]},"NetworkingConfig":{"EndpointsConfig":{"compose-knob-network":{"Aliases":["web","web.compose-knob-bringup.internal"]}}}}';

describe("Podman Compose knob bring-up realization", () => {
  test.each(["/workspace:v1", "/workspace", "/etc/config"])(
    "rejects tmpfs colliding with a planned bind at %s before create",
    async (path) => {
      const fake = makeFakeApi();
      const plan = planWithCompose();
      const target = PortablePath.make(path);
      const service: ServicePlan = {
        ...baseService,
        mounts: [
          {
            type: "bind",
            source: "/host",
            target,
            readOnly: false,
            realization: "passthrough",
            ...(path === "/etc/config" ? { createHostPath: false } : {}),
          },
          { type: "tmpfs", target, readOnly: false, options: "size=64m" },
        ],
      };
      const exit = await Effect.runPromiseExit(
        bringUp({ ...plan, services: { [service.name]: service } }, { api: fake.api, ctx }),
      );
      const failures = Exit.isFailure(exit)
        ? exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)
        : [];
      expect(failures).toContainEqual(
        expect.objectContaining({ _tag: "ServiceStartError", operation: "bringUp.create", service: "web" }),
      );
      expect(findCreateRequest(fake.calls)).toBeUndefined();
    },
  );

  test("Given knobs and plan-derived networking, when creating a container, then HostConfig merges every source", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ privileged: true, cap_add: ["NET_ADMIN"] });

    // When
    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

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
    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

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
    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    // Then
    const create = findCreateRequest(fake.calls);
    const searchParams = new URL(`http://localhost${create?.path ?? ""}`).searchParams;
    expect(searchParams.get("name")).toBe("lando-compose-knob-bringup-web");
    expect(searchParams.get("platform")).toBe("linux/amd64");
  });

  test("Given no plan-derived ExtraHosts, when extra_hosts is realized, then only knob entries are emitted", async () => {
    // Given
    const fake = makeFakeApi();
    const plan = planWithCompose({ extra_hosts: { "api.local": ["10.0.0.1", "10.0.0.2"] } });

    // When
    await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

    // Then
    expect(field(hostConfig(findCreateRequest(fake.calls)), "ExtraHosts")).toEqual([
      "api.local:10.0.0.1",
      "api.local:10.0.0.2",
    ]);
  });

  test.each([
    { compose: {}, expected: ["host.lando.internal:host-gateway"] },
    {
      compose: { extra_hosts: { "api.local": "10.0.0.1" } },
      expected: ["host.lando.internal:host-gateway", "api.local:10.0.0.1"],
    },
  ])(
    "Given plan aliases and $compose, when bringing up, then ExtraHosts is $expected",
    async ({ compose, expected }) => {
      // Given
      const fake = makeFakeApi();
      const plan = planWithCompose(compose, [{ hostname: "host.lando.internal", ip: "host-gateway" }]);

      // When
      await Effect.runPromise(bringUp(plan, { api: fake.api, ctx }));

      // Then
      expect(field(hostConfig(findCreateRequest(fake.calls)), "ExtraHosts")).toEqual(expected);
    },
  );

  test("Given baseline fields and knobs, when both containers are created, then knobs do not clobber baseline fields", async () => {
    // Given
    const baselineFake = makeFakeApi();
    const knobsFake = makeFakeApi();

    // When
    await Effect.runPromise(bringUp(planWithCompose(), { api: baselineFake.api, ctx }));
    await Effect.runPromise(
      bringUp(planWithCompose({ privileged: true, platform: "linux/arm64" }), {
        api: knobsFake.api,
        ctx,
      }),
    );

    // Then
    const baseline = findCreateRequest(baselineFake.calls)?.body;
    const withKnobs = findCreateRequest(knobsFake.calls)?.body;
    const baselineLabels = field(baseline, "Labels");
    const knobLabels = field(withKnobs, "Labels");
    if (typeof baselineLabels !== "object" || baselineLabels === null)
      throw new TypeError("Expected baseline labels");
    if (typeof knobLabels !== "object" || knobLabels === null) throw new TypeError("Expected knob labels");
    expect(field(baselineLabels, CREATE_CONFIG_LABEL)).toMatch(/^v3:[a-f0-9]{64}$/u);
    expect(field(knobLabels, CREATE_CONFIG_LABEL)).toMatch(/^v3:[a-f0-9]{64}$/u);
    expect(field(knobLabels, CREATE_CONFIG_LABEL)).not.toBe(field(baselineLabels, CREATE_CONFIG_LABEL));
    expect({
      Env: field(withKnobs, "Env"),
      Labels: Object.fromEntries(Object.entries(knobLabels).filter(([key]) => key !== CREATE_CONFIG_LABEL)),
      NetworkingConfig: field(withKnobs, "NetworkingConfig"),
      PortBindings: field(field(withKnobs, "HostConfig"), "PortBindings"),
      Binds: field(field(withKnobs, "HostConfig"), "Binds"),
      Mounts: field(field(withKnobs, "HostConfig"), "Mounts"),
    }).toEqual({
      Env: field(baseline, "Env"),
      Labels: Object.fromEntries(
        Object.entries(baselineLabels).filter(([key]) => key !== CREATE_CONFIG_LABEL),
      ),
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
    await Effect.runPromise(bringUp(planWithCompose(), { api: fake.api, ctx }));

    // Then
    const create = findCreateRequest(fake.calls);
    expect(create?.path).toBe("/containers/create?name=lando-compose-knob-bringup-web");
    expect(JSON.stringify(create?.body)).toBe(BASELINE_CREATE_BODY_JSON);
  });
});
