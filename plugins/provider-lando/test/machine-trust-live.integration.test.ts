import { expect, test } from "bun:test";
import { Effect } from "effect";

import {
  ensureMacOSPodmanMachine,
  ensureWindowsPodmanMachine,
  makeSystemPodmanMachineRunner,
} from "@lando/provider-lando";

import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const machinePlatform =
  process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "win32" : undefined;
const machineTrustLive = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_PROVIDER_LANDO_MACHINE_TRUST === "1",
    reason: "LANDO_TEST_PROVIDER_LANDO_MACHINE_TRUST=1 is required",
  },
  {
    available: machinePlatform !== undefined,
    reason: "native macOS or Windows Podman machine host is required",
  },
]);

test.skipIf(!machineTrustLive.available)(
  liveIntegrationTestName(
    "syncs native trust only for an existing Lando-owned Podman machine",
    machineTrustLive,
  ),
  async () => {
    if (machinePlatform === undefined) throw new Error("machine platform prerequisite was not enforced");
    const runner = makeSystemPodmanMachineRunner(
      process.env.LANDO_TEST_PODMAN_COMMAND ?? "podman",
      "lando",
      machinePlatform,
    );
    const status = await Effect.runPromise(runner.inspect);
    expect(status).not.toBe("missing");
    const ensureMachine =
      machinePlatform === "darwin" ? ensureMacOSPodmanMachine : ensureWindowsPodmanMachine;

    await Effect.runPromise(ensureMachine(runner, { name: "lando", createdByLando: true }));

    let userOwnedTrustSyncAttempted = false;
    await Effect.runPromise(
      ensureMachine(
        {
          ...runner,
          syncTrust: Effect.sync(() => {
            userOwnedTrustSyncAttempted = true;
          }),
        },
        { name: "lando", createdByLando: false },
      ),
    );
    expect(userOwnedTrustSyncAttempted).toBe(false);
  },
  120_000,
);
