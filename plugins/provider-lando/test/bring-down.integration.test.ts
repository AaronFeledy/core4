import { describe, expect, test } from "bun:test";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { bringDown, makePodmanApiClient } from "@lando/provider-lando";
import { Clock, Effect } from "effect";
import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";
import { plan, volumeSelector } from "./support/bring-down-fixture.ts";

const volumePruneEligibility = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_VOLUME_PRUNE === "1",
    reason: "LANDO_TEST_VOLUME_PRUNE=1 is required",
  },
  { available: resolveLiveProviderSocket() !== undefined, reason: "a live Podman socket is required" },
]);

describe("provider-lando bringDown", () => {
  test.skipIf(!volumePruneEligibility.available)(
    liveIntegrationTestName(
      "prunes only explicitly created current-app/provider volumes when enabled",
      volumePruneEligibility,
    ),
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");
      const liveRequest = api.request;
      if (liveRequest === undefined) throw new Error("missing request client");
      const suffix = `${Effect.runSync(Clock.currentTimeMillis)}-${Math.random().toString(36).slice(2)}`;
      const owned = `us436-prune-owned-${suffix}`;
      const other = `us436-prune-other-${suffix}`;

      try {
        await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: "/volumes/create",
            body: {
              Name: owned,
              Labels: {
                "dev.lando.app": "bringdownapp",
                "dev.lando.provider": "lando",
                "dev.lando.volume-selector": volumeSelector(plan.id, "data"),
              },
            },
          }),
        );
        await Effect.runPromise(
          liveRequest({
            method: "POST",
            path: "/volumes/create",
            body: {
              Name: other,
              Labels: {
                "dev.lando.app": "other",
                "dev.lando.provider": "lando",
                "dev.lando.volume-selector": volumeSelector("other", "data"),
              },
            },
          }),
        );

        await Effect.runPromise(bringDown(plan, { api, volumes: true }));

        const ownedAfter = await Effect.runPromise(liveRequest({ method: "GET", path: `/volumes/${owned}` }));
        const otherAfter = await Effect.runPromise(liveRequest({ method: "GET", path: `/volumes/${other}` }));
        expect(ownedAfter.status).toBe(404);
        expect(otherAfter.status).toBe(200);
      } finally {
        for (const name of [owned, other]) {
          await Effect.runPromise(Effect.result(liveRequest({ method: "DELETE", path: `/volumes/${name}` })));
        }
      }
    },
  );
});
