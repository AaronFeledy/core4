import { expect, test } from "bun:test";
import { AppPlan, landoNetworkingPlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import { Schema } from "effect";
import { dockerLifecycleDialect, libpodLifecycleDialect } from "../src/dialect.ts";

import { networkOwnershipLabels } from "../src/native-ownership.ts";
import { bringDown } from "../src/podman/bring-down.ts";

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
      networks: [],
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
