import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { makeRuntimeProvider } from "@lando/provider-podman";

const diedEvent = {
  Type: "container",
  Action: "died",
  OOMKilled: true,
  Actor: { Attributes: { name: "lando-myapp-web", "dev.lando.app": "myapp" } },
};

describe("provider-podman container died event provider surface", () => {
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

    const payloads = await Effect.runPromise(provider.getContainerDiedEvents);

    expect(payloads).toEqual([diedEvent]);
  });
});
