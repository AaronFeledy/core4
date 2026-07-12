import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { resolveLiveProviderSocket } from "@lando/core/testing";
import {
  type PodmanApiClient,
  getContainerDiedEvents,
  makePodmanApiClient,
  makeRuntimeProvider,
  parseContainerEventPayloads,
} from "@lando/provider-lando";
import { ProviderUnavailableError } from "@lando/sdk/errors";
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

describe("provider-lando container died event collection", () => {
  test("parses Podman JSON Lines event history and array responses", () => {
    expect(parseContainerEventPayloads(`${JSON.stringify(diedEvent)}\n{"Type":"image"}\n`)).toEqual([
      diedEvent,
      { Type: "image" },
    ]);
    expect(parseContainerEventPayloads(JSON.stringify([diedEvent]))).toEqual([diedEvent]);
    expect(parseContainerEventPayloads("not json\n")).toEqual([]);
  });

  test("requests finite Podman died events and returns raw payloads", async () => {
    const paths: string[] = [];
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.succeed(undefined),
      request: (request) =>
        Effect.sync(() => {
          paths.push(request.path);
          return { status: 200, body: JSON.stringify([diedEvent]) };
        }),
    };

    const payloads = await Effect.runPromise(getContainerDiedEvents(api));

    expect(payloads).toEqual([diedEvent]);
    expect(paths[0]).toContain("/libpod/events");
    expect(paths[0]).toContain("since=");
    expect(paths[0]).toContain("until=");
    expect(paths[0]).not.toContain("stream=false");
    expect(decodeURIComponent(paths[0] ?? "")).toContain("container");
    expect(decodeURIComponent(paths[0] ?? "")).toContain("die");
  });

  test("enriches died events with OOMKilled from container inspect", async () => {
    const eventWithoutOom = {
      ...diedEvent,
      OOMKilled: undefined,
      id: "oom-container-id",
    };
    const paths: string[] = [];
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.succeed(undefined),
      request: (request) =>
        Effect.sync(() => {
          paths.push(request.path);
          return request.path.startsWith("/libpod/events")
            ? { status: 200, body: JSON.stringify([eventWithoutOom]) }
            : { status: 200, body: JSON.stringify({ State: { OOMKilled: true } }) };
        }),
    };

    const payloads = await Effect.runPromise(getContainerDiedEvents(api));

    expect(paths).toEqual([expect.stringContaining("/libpod/events"), "/containers/oom-container-id/json"]);
    expect(payloads).toEqual([{ ...eventWithoutOom, OOMKilled: true }]);
  });

  test("maps event collection failures to the requested provider id", async () => {
    const api: PodmanApiClient = {
      info: Effect.succeed({}),
      ping: Effect.succeed(undefined),
      request: () => Effect.succeed({ status: 500, body: "registry ACCESS_TOKEN=s3cr3t" }),
    };

    const error = await Effect.runPromise(
      getContainerDiedEvents(api, { providerId: "podman" }).pipe(Effect.flip),
    );

    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(error.providerId).toBe("podman");
    expect(JSON.stringify(error)).not.toContain("s3cr3t");
  });

  test("provider exposes died events structurally for doctor", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
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
