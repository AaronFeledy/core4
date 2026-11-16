import { describe, test } from "bun:test";

import {
  type BuildOutputContractInput,
  assertBuildOutputSinkDoesNotOverlap,
  assertFailedBuildDeliversOutput,
  assertPassingBuildDeliversOutputInOrder,
} from "@lando/container-runtime/testing/build-output-contract";
import { buildKeyForService } from "@lando/engine/services/build-key";
import { stripHostProxyRunLando } from "@lando/engine/subsystems/host-proxy/transport-feature";
import { resolveLiveProviderSocket } from "@lando/engine/testing/live-provider-socket";
import { makePodmanApiClient } from "@lando/provider-lando";
import { ProviderId } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect } from "effect";

import { makeProviderLayer } from "./support/contract-provider-layer.ts";

const providerId = ProviderId.make("lando");
const socketPath = resolveLiveProviderSocket()?.socketPath;
const skip = socketPath === undefined ? " (SKIP: answering LANDO_TEST_PODMAN_SOCKET required)" : "";

const liveContract = async (): Promise<BuildOutputContractInput> => {
  if (socketPath === undefined) throw new Error("answering LANDO_TEST_PODMAN_SOCKET required");
  const api = makePodmanApiClient(socketPath);
  const provider = await Effect.runPromise(
    RuntimeProvider.pipe(
      Effect.provide(
        makeProviderLayer({
          sanitizeAppliedPlan: stripHostProxyRunLando,
          platform: "linux",
          podmanApi: api,
        }),
      ),
    ),
  );
  return { provider, api, providerId, buildKeyFor: (service) => buildKeyForService(provider, service) };
};

describe("provider-lando buildArtifact output — live Podman", () => {
  test.skipIf(socketPath === undefined)(
    `delivers step output before failing with ArtifactBuildError${skip}`,
    async () => {
      await assertFailedBuildDeliversOutput(await liveContract());
    },
    120_000,
  );

  test.skipIf(socketPath === undefined)(
    `delivers passing step output in order and returns a removable artifact${skip}`,
    async () => {
      await assertPassingBuildDeliversOutputInOrder(await liveContract());
    },
    120_000,
  );

  test.skipIf(socketPath === undefined)(
    `awaits each onOutput call before starting the next${skip}`,
    async () => {
      await assertBuildOutputSinkDoesNotOverlap(await liveContract());
    },
    120_000,
  );
});
