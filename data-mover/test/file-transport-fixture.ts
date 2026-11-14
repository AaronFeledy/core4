import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { makeLandoPaths } from "@lando/paths";
import type { RuntimeProviderShape } from "@lando/sdk/services";
import { TestRuntimeProvider } from "@lando/sdk/test";
import { makeTestStateStore } from "@lando/state-store/testing";
import { Effect } from "effect";
import { makeDataMoverService } from "../src/service.ts";
import { privateFileAccess } from "./private-file-access.ts";

export const withFileTransport = async (
  body: (fixture: Awaited<ReturnType<typeof fileTransportFixture>>) => Promise<void>,
) => {
  const root = await mkdtemp(join(process.cwd(), ".tmp-file-transport-"));
  try {
    await body(fileTransportFixture(root));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const fileTransportFixture = (root: string) => {
  const paths = makeLandoPaths({ userCacheRoot: root });
  const mover = (provider: RuntimeProviderShape = TestRuntimeProvider, access = privateFileAccess) =>
    makeDataMoverService(
      Effect.succeed(provider),
      { redactText: (text) => text, publish: () => Effect.void },
      { paths, stateStore: makeTestStateStore().service, privateFileAccess: access },
    );
  return { root, paths, mover };
};
