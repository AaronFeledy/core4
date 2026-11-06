import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { DateTime, Effect } from "effect";
import { APP_LABEL, APP_ROOT_LABEL } from "../src/labels.ts";
import { containerOwnershipLabels } from "../src/native-ownership.ts";
import { inspect } from "../src/podman/inspect.ts";

const metadata = { resolvedAt: DateTime.makeUnsafe(0), source: "inspect-state", runtime: 4 as const };
const service: ServicePlan = {
  name: ServiceName.make("web"),
  type: "node",
  provider: ProviderId.make("podman"),
  primary: true,
  environment: {},
  mounts: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};
const plan: AppPlan = {
  id: AppId.make("inspect-state"),
  name: "inspect-state",
  slug: "inspect-state",
  root: AbsolutePath.make("/tmp/inspect-state"),
  provider: service.provider,
  services: { [service.name]: service },
  routes: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("projects mounts and connections from one container inspect request", async () => {
  const requests: string[] = [];
  const result = await Effect.runPromise(
    inspect(
      plan,
      { app: plan.id, service: service.name },
      {
        api: {
          request: (request) =>
            Effect.sync(() => {
              requests.push(request.path);
              return {
                status: 200,
                body: JSON.stringify({
                  State: { Running: true },
                  Mounts: [{ Type: "volume", Name: "db", Destination: "/data", RW: true }],
                  NetworkSettings: { Ports: { "80/tcp": [{ HostIp: "127.0.0.1", HostPort: "8080" }] } },
                }),
              };
            }),
        },
        ctx: { providerId: "podman", remediation: "Retry inspect.", env: {} },
      },
    ),
  );
  expect(requests).toEqual(["/containers/lando-inspect-state--web/json"]);
  expect(result.mounts).toEqual({
    status: "present",
    mounts: [{ type: "volume", source: "db", target: "/data", readOnly: false }],
  });
  expect(result.publications).toEqual({
    status: "present",
    bindings: [{ port: 80, transport: "tcp", bindAddress: "127.0.0.1", hostPort: 8080 }],
  });
});

test("marks mounts missing only when the container is absent", async () => {
  const result = await Effect.runPromise(
    inspect(
      plan,
      { app: plan.id, service: service.name },
      {
        api: { request: () => Effect.succeed({ status: 404, body: "" }) },
        ctx: { providerId: "podman", remediation: "Retry inspect.", env: {} },
      },
    ),
  );
  expect(result.status).toBe("absent");
  expect(result.mounts).toEqual({ status: "missing" });
});

test.each([{}, { State: {} }, { State: { Status: "unrecognized" } }])(
  "preserves unknown state when successful inspect lacks state evidence: %j",
  async (body) => {
    // Given a successful but inconclusive engine response.
    const api = { request: () => Effect.succeed({ status: 200, body: JSON.stringify(body) }) };
    // When
    const result = await Effect.runPromise(
      inspect(
        plan,
        { app: plan.id, service: service.name },
        {
          api,
          ctx: { providerId: "podman", remediation: "Retry inspect.", env: {} },
        },
      ),
    );
    // Then
    expect(result).toMatchObject({
      status: "unknown",
      publications: { status: "unknown" },
    });
  },
);

test.each([
  ["created", "created"],
  ["exited", "exited"],
  ["dead", "dead"],
  ["stopped", "exited"],
] as const)("retains known stopped evidence for %s", async (Status, expected) => {
  // Given
  const api = {
    request: () => Effect.succeed({ status: 200, body: JSON.stringify({ State: { Status } }) }),
  };
  // When
  const result = await Effect.runPromise(
    inspect(
      plan,
      { app: plan.id, service: service.name },
      {
        api,
        ctx: { providerId: "podman", remediation: "Retry inspect.", env: {} },
      },
    ),
  );
  // Then
  expect(result).toMatchObject({ status: expected });
});

test.each([true, false])(
  "does not claim a foreign-root container as owned (coherent=%s)",
  async (coherent) => {
    // Given: the planned service name is held by another Lando app's container.
    const foreignRoot = "/home/me/other";
    const labels = {
      ...containerOwnershipLabels(plan, service.name),
      [APP_ROOT_LABEL]: foreignRoot,
      [APP_LABEL]: coherent ? "other-app" : "",
    };
    // When
    const result = await Effect.runPromise(
      inspect(
        plan,
        { app: plan.id, service: service.name },
        {
          api: {
            request: () =>
              Effect.succeed({
                status: 200,
                body: JSON.stringify({
                  Id: "foreign-container",
                  State: { Running: true, Status: "running" },
                  Config: { Labels: labels },
                  NetworkSettings: { Ports: {} },
                }),
              }),
          },
          ctx: { providerId: "podman", remediation: "Retry inspect.", env: {} },
        },
      ),
    );
    // Then: no container identity or running claim for this plan.
    expect(result).toMatchObject({
      status: "unknown",
      publications: { status: "unknown" },
      mounts: { status: "unknown" },
    });
    expect(result.containerId).toBeUndefined();
    expect(result.labels?.[APP_ROOT_LABEL]).toBe(foreignRoot);
  },
);
