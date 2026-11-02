import { test } from "bun:test";
import { Effect } from "effect";

import { RuntimeProvider } from "@lando/sdk/services";
import { makeProviderLayer } from "./provider-fixture.ts";

const liveDesktopSocket = process.env.LANDO_TEST_PODMAN_DESKTOP_SOCKET;
const liveDesktopPlatform = process.platform === "darwin" || process.platform === "win32";
const liveDesktopTest =
  liveDesktopSocket !== undefined && liveDesktopSocket.length > 0 && liveDesktopPlatform ? test : test.skip;

liveDesktopTest(
  "live: Podman Desktop socket reachable via SDK provider contract",
  async () => {
    const { runProviderContract } = await import("@lando/sdk/test");
    const { makePodmanApiClient } = await import("@lando/provider-podman");
    const socket = liveDesktopSocket ?? "";

    const provider = await Effect.runPromise(
      RuntimeProvider.pipe(
        Effect.provide(
          makeProviderLayer({
            podmanApi: makePodmanApiClient(socket),
            platform: process.platform === "darwin" ? "darwin" : "win32",
          }),
        ),
      ),
    );

    await Effect.runPromise(runProviderContract(provider));
  },
  120_000,
);
