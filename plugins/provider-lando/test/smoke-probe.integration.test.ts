import { expect, test } from "bun:test";
import { Effect } from "effect";

import { makePodmanApiClient, runSmokeReadinessProbe } from "@lando/provider-lando";

import { liveIntegrationEligibility, liveIntegrationTestName } from "./live-integration.ts";

const eligibility = liveIntegrationEligibility([
  {
    available: process.env.LANDO_TEST_PODMAN_SOCKET !== undefined,
    reason: "LANDO_TEST_PODMAN_SOCKET is required",
  },
]);

test.skipIf(!eligibility.available)(
  liveIntegrationTestName("completes the outcome-based Podman smoke probe", eligibility),
  async () => {
    const socketPath = process.env.LANDO_TEST_PODMAN_SOCKET;
    expect(socketPath).toBeDefined();
    await Effect.runPromise(
      Effect.scoped(runSmokeReadinessProbe({ podmanApi: makePodmanApiClient(socketPath ?? "") })),
    );
  },
  120_000,
);
