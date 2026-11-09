import { describe, expect, test } from "bun:test";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makePodmanApiClient } from "@lando/provider-podman";
import { RuntimeProvider } from "@lando/sdk/services";
import { runProviderContract } from "@lando/sdk/test";
import { Effect } from "effect";
import { makeProviderLayer } from "./support/contract-provider-layer.ts";

describe("provider-podman RuntimeProvider contract", () => {
  test.skipIf(resolveLiveProviderSocket() === undefined)(
    "passes the SDK provider contract suite against a live Podman socket",
    async () => {
      const socketPath = resolveLiveProviderSocket()?.socketPath;
      expect(socketPath).toBeTruthy();

      const provider = await Effect.runPromise(
        RuntimeProvider.pipe(
          Effect.provide(
            makeProviderLayer({
              podmanApi: makePodmanApiClient(socketPath ?? ""),
              platform: "linux",
            }),
          ),
        ),
      );

      await Effect.runPromise(runProviderContract(provider));
    },
    60_000,
  );
});
