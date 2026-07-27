import { describe, expect, test } from "bun:test";
import { DateTime, Effect } from "effect";

import { type PodmanApiClient, type PodmanHttpRequest, bringUp } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";

import { KNOB_FIXTURES } from "./compose-knobs-fixtures.ts";

const providerId = ProviderId.make("lando");
const serviceName = ServiceName.make("web");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-27T00:00:00Z"),
  source: "provider-lando/compose-knobs-request-body.test.ts",
  runtime: 4 as const,
};

const planWithCompose = (compose: Record<string, unknown>): AppPlan => {
  const service: ServicePlan = {
    name: serviceName,
    type: "web",
    provider: providerId,
    primary: true,
    artifact: { kind: "ref", ref: "nginx:1.27-alpine" },
    environment: {},
    mounts: [],
    storage: [],
    endpoints: [],
    routes: [],
    dependsOn: [],
    hostAliases: [],
    metadata,
    extensions: { compose },
  };

  return {
    id: AppId.make("compose-knob-request-body"),
    name: "Compose Knob Request Body",
    slug: "compose-knob-request-body",
    root: AbsolutePath.make("/tmp/lando-compose-knob-request-body"),
    provider: providerId,
    services: { [service.name]: service },
    routes: [],
    networks: [],
    networking: { perAppBridge: { name: "compose-knob-request-network", driver: "bridge" } },
    stores: [],
    fileSync: [],
    metadata,
    extensions: {},
  };
};

const captureCreateRequest = async (compose: Record<string, unknown>): Promise<PodmanHttpRequest> => {
  let createRequest: PodmanHttpRequest | undefined;
  let running = false;
  const api: PodmanApiClient = {
    info: Effect.succeed({}),
    ping: Effect.succeed(undefined),
    request: (request) =>
      Effect.sync(() => {
        if (request.method === "GET" && request.path.startsWith("/networks/")) {
          return { status: 200, body: "{}" };
        }
        if (request.method === "GET" && request.path.endsWith("/json")) {
          return createRequest === undefined
            ? { status: 404, body: "{}" }
            : { status: 200, body: JSON.stringify({ State: { Running: running } }) };
        }
        if (request.method === "POST" && request.path.startsWith("/containers/create")) {
          createRequest = request;
          return { status: 201, body: "{}" };
        }
        if (request.method === "POST" && request.path.endsWith("/start")) {
          running = true;
          return { status: 204, body: "" };
        }
        return { status: 500, body: `unexpected ${request.method} ${request.path}` };
      }),
  };

  await Effect.runPromise(bringUp(planWithCompose(compose), { podmanApi: api }));
  if (createRequest === undefined) throw new Error("bringUp did not issue a container create request");
  return createRequest;
};

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null ? Reflect.get(value, key) : undefined;

describe("provider-lando Compose knob create request", () => {
  for (const [knob, fixture] of Object.entries(KNOB_FIXTURES)) {
    test(`Given the ${knob} knob, when bringUp creates the container, then the final request contains its mapping`, async () => {
      const request = await captureCreateRequest(fixture.input);
      const hostConfig = field(request.body, "HostConfig");
      const searchParams = new URL(`http://localhost${request.path}`).searchParams;

      for (const [key, value] of Object.entries(fixture.expected.hostConfig)) {
        expect(field(hostConfig, key)).toEqual(value);
      }
      for (const [key, value] of Object.entries(fixture.expected.topLevel)) {
        expect(field(request.body, key)).toEqual(value);
      }
      for (const [key, value] of Object.entries(fixture.expected.query)) {
        expect(searchParams.get(key)).toBe(value);
      }
    });
  }
});
