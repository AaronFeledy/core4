import { expect, test } from "bun:test";
import { AppPlan, landoNetworkingPlan } from "@lando/sdk/schema";
import { Effect, Result } from "effect";
import { Schema } from "effect";
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../src/dialect.ts";

import { networkOwnershipLabels } from "../src/native-ownership.ts";
import { bringDown } from "../src/podman/bring-down.ts";
import { networkPlan } from "./authored-network-fixture.ts";

test.each([false, true])(
  "removes bridge and owned authored networks by verified id (bridge missing=%s)",
  async (bridgeMissing) => {
    // Given
    const plan = networkPlan;
    const requests: string[] = [];
    // When
    const result = await Effect.runPromise(
      bringDown(plan, {
        ctx: { providerId: "docker", remediation: "Retry.", env: {} },
        api: {
          request: (request) =>
            Effect.sync(() => {
              requests.push(`${request.method} ${request.path}`);
              if (request.path.startsWith("/containers/")) return { status: 404, body: "{}" };
              if (request.method === "DELETE") return { status: 204, body: "" };
              if (bridgeMissing && request.path === "/networks/lando-networks")
                return { status: 404, body: "{}" };
              return {
                status: 200,
                body: JSON.stringify({
                  Id: `verified-${request.path.slice(10)}`,
                  Labels: networkOwnershipLabels(plan),
                }),
              };
            }),
        },
      }),
    );
    // Then
    expect(result.changed).toBe(true);
    expect(requests.filter((request) => request.includes("/networks/"))).toEqual([
      "GET /networks/lando-networks",
      ...(bridgeMissing ? [] : ["DELETE /networks/verified-lando-networks"]),
      "GET /networks/lando-networks_private",
      "DELETE /networks/verified-lando-networks_private",
    ]);
  },
);

test("narrowed teardown retains authored networks with unselected members", async () => {
  // Given
  const networking = networkPlan.networking;
  if (networking === undefined) throw new TypeError("Missing networking fixture");
  const plan = {
    ...networkPlan,
    services: Object.fromEntries(Object.entries(networkPlan.services).filter(([name]) => name === "web")),
    networking: {
      ...networking,
      authoredNetworks: (networking.authoredNetworks ?? []).map((network) => ({
        ...network,
        members: { ...network.members, worker: { aliases: [] } },
      })),
    },
  };
  const requests: string[] = [];
  // When
  await Effect.runPromise(
    bringDown(plan, {
      ctx: { providerId: "docker", remediation: "Retry.", env: {} },
      api: {
        request: (request) =>
          Effect.sync(() => {
            requests.push(`${request.method} ${request.path}`);
            return { status: 404, body: "{}" };
          }),
      },
    }),
  );
  // Then
  expect(requests.filter((request) => request.includes("/networks/"))).toEqual([
    "GET /networks/lando-networks",
  ]);
});

test.each([{ Labels: {} }, { Labels: null }, {}])(
  "planful teardown refuses unlabeled authored networks: %j",
  async (legacy) => {
    // Given
    const requests: string[] = [];
    // When
    const result = await Effect.runPromise(
      bringDown(networkPlan, {
        ctx: { providerId: "docker", remediation: "Retry.", env: {} },
        api: {
          request: (request) =>
            Effect.sync(() => {
              requests.push(`${request.method} ${request.path}`);
              if (request.path !== "/networks/lando-networks_private") return { status: 404, body: "{}" };
              return {
                status: 200,
                body: JSON.stringify({ Id: "unlabeled", Name: "lando-networks_private", ...legacy }),
              };
            }),
        },
      }).pipe(Effect.result),
    );
    // Then
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result))
      expect(result.failure).toMatchObject({
        _tag: "ProviderUnavailableError",
        operation: "resource-ownership",
      });
    expect(requests.some((request) => request.startsWith("DELETE"))).toBe(false);
  },
);

test("Podman bring-down removes the private network named in the realized plan", async () => {
  const requests: string[] = [];
  const plan = {
    id: "site",
    slug: "site",
    root: "/app",
    provider: "lando",
    services: {},
    networking: {
      perAppBridge: { name: "lando-vm-aabbccddeeff-112233445566", driver: "bridge" },
      sharedNetworkMembership: { name: "lando-vm-aabbccddeeff-66778899aabb", aliases: {} },
    },
  } as Parameters<typeof bringDown>[0];
  const result = await Effect.runPromise(
    bringDown(plan, {
      api: {
        request: (request) =>
          Effect.sync(() => {
            requests.push(`${request.method} ${request.path}`);
            if (request.method === "GET")
              return {
                status: 200,
                body: JSON.stringify({
                  Id: "observed-private-network",
                  Labels: networkOwnershipLabels(plan),
                }),
              };
            return { status: 204, headers: {}, body: "" };
          }),
      },
      ctx: { providerId: "lando", remediation: "retry", env: {} },
    }),
  );
  expect(result.changed).toBe(true);
  expect(requests).toEqual([
    "GET /networks/lando-vm-aabbccddeeff-112233445566",
    "DELETE /networks/observed-private-network",
  ]);
});

test.each([dockerLifecycleDialect, libpodLifecycleDialect])(
  "$engine leaves shared-only networks untouched on teardown",
  async (dialect) => {
    const requests: string[] = [];
    const plan = Schema.decodeUnknownSync(AppPlan)({
      id: "global",
      name: "global",
      slug: "global",
      root: "/global",
      provider: "docker",
      services: {},
      routes: [],
      stores: [],
      fileSync: [],
      extensions: {},
      metadata: { runtime: 4, resolvedAt: "2026-10-21T00:00:00Z", source: "test" },
      networking: landoNetworkingPlan({
        slug: "global",
        serviceNames: [],
        perAppBridge: false,
        sharedCrossAppNetwork: true,
      }),
    });
    const result = await Effect.runPromise(
      bringDown(plan, {
        dialect,
        ctx: { providerId: "docker", remediation: "retry", env: {} },
        api: {
          request: (request) =>
            Effect.sync(() => {
              requests.push(request.path);
              return { status: 404, body: "" };
            }),
        },
      }),
    );
    expect(requests).toEqual([]);
    expect(result.changed).toBe(false);
  },
);
