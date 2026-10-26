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
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../src/dialect.ts";
import type { EngineHttpRequest, EngineHttpResponse, PodmanApiClient } from "../src/engine-api.ts";
import { bringUp } from "../src/podman/bring-up.ts";

const providerId = ProviderId.make("lando");
const ctx = { providerId: "podman", remediation: "Run `lando setup` and retry.", env: {} } as const;
const appId = AppId.make("mounts-wire");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.makeUnsafe("2026-10-25T00:00:00Z"),
  source: "container-runtime/bring-up-mounts-wire.test.ts",
  runtime: 4 as const,
};

const baseService = (mounts: ServicePlan["mounts"]): ServicePlan => ({
  name: serviceName,
  type: "web",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
  environment: {},
  mounts,
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
});

const planWith = (mounts: ServicePlan["mounts"]): AppPlan => {
  const service = baseService(mounts);
  return {
    id: appId,
    valueModel: 1,
    name: "Mounts Wire",
    slug: "mounts-wire",
    root: AbsolutePath.make("/tmp/lando-mounts-wire"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
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
        if (request.method === "POST" && request.path.endsWith("/connect")) {
          return { status: 200, body: "{}" };
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

describe("bring-up mount wire", () => {
  for (const dialect of [libpodLifecycleDialect, dockerLifecycleDialect]) {
    test(`${dialect.engine}: tmpfs mounts reach HostConfig.Tmpfs on the create body`, async () => {
      const fake = makeFakeApi();
      const plan = planWith([
        {
          type: "tmpfs",
          target: PortablePath.make("/scratch"),
          readOnly: false,
          options: "size=64m,mode=1777",
        },
        {
          type: "tmpfs",
          target: PortablePath.make("/run:x"),
          readOnly: true,
          options: "size=8m",
        },
      ]);

      await Effect.runPromise(bringUp(plan, { api: fake.api, ctx, dialect }));

      const create = findCreateRequest(fake.calls);
      expect(create).toBeDefined();
      expect(field(hostConfig(create), "Tmpfs")).toEqual({
        "/scratch": "size=64m,mode=1777",
        "/run:x": "ro,size=8m",
      });
    });
  }

  test("duplicate mount targets fail before the create request", async () => {
    const fake = makeFakeApi();
    const target = PortablePath.make("/workspace");
    const plan = planWith([
      {
        type: "bind",
        source: AbsolutePath.make("/tmp/a"),
        target,
        readOnly: false,
        realization: "passthrough",
      },
      {
        type: "tmpfs",
        target,
        readOnly: false,
      },
    ]);

    const exit = await Effect.runPromiseExit(bringUp(plan, { api: fake.api, ctx }));
    const failures = Exit.isFailure(exit)
      ? Array.from(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      : [];
    expect(failures).toContainEqual(
      expect.objectContaining({
        _tag: "ServiceStartError",
        operation: "bringUp.create",
        message: expect.stringMatching(/Failed to build .* container create payload/u),
      }),
    );
    const cause = failures
      .map((error): unknown => Reflect.get(error, "cause"))
      .find((value) => value !== undefined);
    expect(cause).toMatchObject({
      _tag: "ContainerPlanError",
      message: "Container mounts repeat a target.",
      details: expect.objectContaining({ target }),
    });
    expect(findCreateRequest(fake.calls)).toBeUndefined();
  });
});
