import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { type PodmanApiClient, getContainerDiedEvents, makeRuntimeProvider } from "@lando/provider-podman";

const diedEvent = {
  Type: "container",
  Action: "died",
  OOMKilled: true,
  Actor: { Attributes: { name: "lando-myapp-web", "dev.lando.app": "myapp" } },
};

describe("provider-podman container died event collection", () => {
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
  });

  test("provider exposes died events structurally for doctor", async () => {
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        platform: "linux",
        env: {},
        conflictDetector: () => Effect.void,
        podmanApi: {
          info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
          ping: Effect.succeed(undefined),
          request: () => Effect.succeed({ status: 200, body: JSON.stringify([diedEvent]) }),
        },
      }),
    );

    if (!("getContainerDiedEvents" in provider)) throw new Error("missing died-event provider extension");
    const payloads = await Effect.runPromise(provider.getContainerDiedEvents);

    expect(payloads).toEqual([diedEvent]);
  });
});
