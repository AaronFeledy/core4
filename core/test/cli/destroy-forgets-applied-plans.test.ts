import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DateTime, Effect, Exit } from "effect";

import { makePluginStateStore, stripHostProxyRunLando } from "@lando/core/testing";
import { makeLandoPaths } from "@lando/paths";
import { makeProviderLayer, persistAppliedPlan } from "@lando/provider-lando";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { RuntimeProvider } from "@lando/sdk/services";
import { makeStateStore } from "@lando/state-store/service";

import { readAppliedPlansFromUserData } from "../../src/cli/commands/list-discovery.ts";

const providerId = ProviderId.make("lando");
const appId = AppId.make("us586-verify-lando");

const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-05-15T00:00:00Z"),
  source: "destroy-forgets-applied-plans.test",
  runtime: 4 as const,
};

const web: ServicePlan = {
  name: ServiceName.make("web"),
  type: "nginx",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "nginx:alpine" },
  command: ["nginx"],
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [{ _tag: "internal", port: 80, protocol: "http", name: "http" }],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "us586-verify-lando",
  slug: "us586-verify-lando",
  root: AbsolutePath.make("/tmp/us586-verify-lando"),
  provider: providerId,
  services: { [web.name]: web },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

const missingPodmanApi = {
  info: Effect.void,
  ping: Effect.void,
  request: () => Effect.succeed({ status: 404, body: "" }),
};

const withUserDataRoot = async <T>(run: (userDataRoot: string) => Promise<T>): Promise<T> => {
  const userDataRoot = await mkdtemp(join(tmpdir(), "lando-destroy-forgets-"));
  try {
    return await run(userDataRoot);
  } finally {
    await rm(userDataRoot, { recursive: true, force: true });
  }
};

const liveAppliedState = (userDataRoot: string) => {
  const paths = makeLandoPaths({ userDataRoot });
  const pluginStateDir = paths.pluginStateDir("@lando/provider-lando");
  return {
    pluginStateDir,
    stateDir: `${userDataRoot}/providers`,
    appliedPlanState: makePluginStateStore(makeStateStore(), AbsolutePath.make(pluginStateDir)),
  };
};

const listedAppIds = async (userDataRoot: string): Promise<string[]> =>
  (await readAppliedPlansFromUserData(userDataRoot)).map((entry) => entry.appId);

const makeProvider = async (userDataRoot: string, withApi: boolean) => {
  const live = liveAppliedState(userDataRoot);
  return Effect.runPromise(
    RuntimeProvider.pipe(
      Effect.provide(
        makeProviderLayer({
          sanitizeAppliedPlan: stripHostProxyRunLando,
          platform: "linux",
          stateDir: live.stateDir,
          appliedPlanState: live.appliedPlanState,
          appliedPlanStateDir: live.pluginStateDir,
          ...(withApi ? { podmanApi: missingPodmanApi } : {}),
        }),
      ),
    ),
  );
};

const persistLivePlan = async (userDataRoot: string): Promise<void> => {
  const live = liveAppliedState(userDataRoot);
  await Effect.runPromise(persistAppliedPlan(live.appliedPlanState, plan));
};

describe("provider-lando destroy vs apps:list inventory", () => {
  test("destroy with removeState drops the applied plan that apps:list still listed for the destroyed app", async () => {
    await withUserDataRoot(async (userDataRoot) => {
      await persistLivePlan(userDataRoot);
      expect(await listedAppIds(userDataRoot)).toEqual([String(appId)]);

      const provider = await makeProvider(userDataRoot, true);
      await Effect.runPromise(
        provider.destroy({ app: plan.id, plan }, { volumes: false, removeState: true }),
      );

      expect(await listedAppIds(userDataRoot)).toEqual([]);
    });
  });

  test("destroy still drops the apps:list plan when bringDown cannot reach the runtime", async () => {
    await withUserDataRoot(async (userDataRoot) => {
      await persistLivePlan(userDataRoot);
      const provider = await makeProvider(userDataRoot, false);
      const exit = await Effect.runPromiseExit(
        provider.destroy({ app: plan.id, plan }, { volumes: false, removeState: true }),
      );

      expect(Exit.isFailure(exit)).toBe(true);
      expect(await listedAppIds(userDataRoot)).toEqual([]);
    });
  });

  test("stop-style destroy keeps the applied plan apps:list reads", async () => {
    await withUserDataRoot(async (userDataRoot) => {
      await persistLivePlan(userDataRoot);
      const provider = await makeProvider(userDataRoot, true);
      await Effect.runPromise(
        provider.destroy({ app: plan.id, plan }, { volumes: false, removeState: false }),
      );

      expect(await listedAppIds(userDataRoot)).toEqual([String(appId)]);
    });
  });
});
