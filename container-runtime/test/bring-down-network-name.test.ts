import { expect, test } from "bun:test";
import { Effect } from "effect";

import { bringDown } from "../src/podman/bring-down.ts";

test("Podman bring-down removes the private network named in the realized plan", async () => {
  const requests: string[] = [];
  const plan = {
    id: "site",
    slug: "site",
    root: "/app",
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
            return { status: 204, headers: {}, body: "" };
          }),
      },
      ctx: { providerId: "lando", remediation: "retry" },
    }),
  );
  expect(result.changed).toBe(true);
  expect(requests).toEqual(["DELETE /networks/lando-vm-aabbccddeeff-112233445566"]);
});
