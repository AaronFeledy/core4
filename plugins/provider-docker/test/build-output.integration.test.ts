import { describe, test } from "bun:test";

import {
  type BuildOutputContractInput,
  assertBuildOutputSinkDoesNotOverlap,
  assertFailedBuildDeliversOutput,
  assertPassingBuildDeliversOutputInOrder,
} from "@lando/container-runtime/testing/build-output-contract";
import { buildKeyForService } from "@lando/engine/services/build-key";
import { makeDockerApiClient } from "@lando/provider-docker";
import { ProviderId } from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { Effect, Exit } from "effect";

import { makeProviderLayer } from "./support/contract-provider-layer.ts";

const providerId = ProviderId.make("docker");
const dockerHost = process.env.LANDO_TEST_DOCKER_SOCKET ?? process.env.DOCKER_HOST;
const api = dockerHost === undefined ? undefined : makeDockerApiClient(dockerHost);
// A configured host that no longer answers is a dead socket, not a live suite.
const live = api !== undefined && Exit.isSuccess(await Effect.runPromiseExit(api.info));
const skip = live ? "" : " (SKIP: answering LANDO_TEST_DOCKER_SOCKET or DOCKER_HOST required)";

const liveContract = async (): Promise<BuildOutputContractInput> => {
  if (api === undefined) throw new Error("answering Docker socket required");
  const provider = await Effect.runPromise(
    RuntimeProvider.pipe(Effect.provide(makeProviderLayer({ platform: "linux", dockerApi: api }))),
  );
  return { provider, api, providerId, buildKeyFor: (service) => buildKeyForService(provider, service) };
};

describe("provider-docker buildArtifact output — live Docker Engine", () => {
  test.skipIf(!live)(
    `delivers step output before failing with ArtifactBuildError${skip}`,
    async () => {
      await assertFailedBuildDeliversOutput(await liveContract());
    },
    120_000,
  );

  test.skipIf(!live)(
    `delivers passing step output in order and returns a removable artifact${skip}`,
    async () => {
      await assertPassingBuildDeliversOutputInOrder(await liveContract());
    },
    120_000,
  );

  test.skipIf(!live)(
    `awaits each onOutput call before starting the next${skip}`,
    async () => {
      await assertBuildOutputSinkDoesNotOverlap(await liveContract());
    },
    120_000,
  );
});
