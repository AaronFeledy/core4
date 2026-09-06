import { describe, expect, test } from "bun:test";
import { resolveLiveProviderSocket, stripHostProxyRunLando } from "@lando/core/testing";
import { Effect } from "effect";

import { getContainerDiedEvents, makePodmanApiClient, makeRuntimeProvider } from "@lando/provider-lando";
import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const diedEvent = {
  Type: "container",
  Action: "died",
  OOMKilled: true,
  Actor: { Attributes: { name: "lando-myapp-web", "dev.lando.app": "myapp" } },
};
const oomEventsLive = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_OOM_EVENTS === "1",
    reason: "LANDO_TEST_OOM_EVENTS=1 is required",
  },
  { available: resolveLiveProviderSocket() !== undefined, reason: "a live Podman socket is required" },
]);

describe("provider-lando container died event provider surface", () => {
  test("provider exposes died events structurally for doctor", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        sanitizeAppliedPlan: stripHostProxyRunLando,
        platform: "linux",
        podmanApi: {
          info: Effect.succeed({ host: { arch: "x64" } }),
          ping: Effect.succeed(undefined),
          request: () => Effect.succeed({ status: 200, body: JSON.stringify([diedEvent]) }),
        },
      }),
    );

    if (!("getContainerDiedEvents" in provider)) throw new Error("missing died-event provider extension");
    const payloads = await Effect.runPromise(provider.getContainerDiedEvents);

    expect(payloads).toEqual([diedEvent]);
  });

  test.skipIf(!oomEventsLive.available)(
    liveIntegrationTestName(
      "collects a live OOMKilled Podman died event for doctor when explicitly enabled",
      oomEventsLive,
    ),
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();
      const api = makePodmanApiClient(socketPath ?? "");
      const request = api.request;
      if (request === undefined) throw new Error("missing request client");
      const name = `lando-us436-oom-${Date.now()}`;

      try {
        const created = await Effect.runPromise(
          request({
            method: "POST",
            path: `/containers/create?name=${encodeURIComponent(name)}`,
            body: {
              Image: "docker.io/library/alpine:3.20.3",
              Cmd: ["sh", "-c", "x=a; while true; do x=$x$x$x$x; done"],
              HostConfig: { Memory: 8 * 1024 * 1024, MemorySwap: 8 * 1024 * 1024 },
              Labels: { "dev.lando.app": "us436-oom", "dev.lando.service": "oom" },
            },
          }),
        );
        expect(created.status).toBe(201);
        const started = await Effect.runPromise(
          request({ method: "POST", path: `/containers/${encodeURIComponent(name)}/start` }),
        );
        expect(started.status).toBe(204);

        let stopped = false;
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const inspected = await Effect.runPromise(
            request({ method: "GET", path: `/containers/${encodeURIComponent(name)}/json` }),
          );
          const state = JSON.parse(inspected.body) as { readonly State?: { readonly Running?: boolean } };
          if (state.State?.Running === false) {
            stopped = true;
            break;
          }
          await Bun.sleep(500);
        }
        expect(stopped).toBe(true);
        let serialized = "";
        for (let attempt = 0; attempt < 20; attempt += 1) {
          serialized = JSON.stringify(await Effect.runPromise(getContainerDiedEvents(api)));
          if (serialized.includes(name)) break;
          await Bun.sleep(250);
        }

        expect(serialized).toContain(name);
        expect(serialized).toMatch(/OOMKilled|oom/i);
      } finally {
        await Effect.runPromise(
          Effect.either(request({ method: "POST", path: `/containers/${encodeURIComponent(name)}/stop` })),
        );
        await Effect.runPromise(
          Effect.either(
            request({ method: "DELETE", path: `/containers/${encodeURIComponent(name)}?force=true` }),
          ),
        );
      }
    },
    30_000,
  );
});
