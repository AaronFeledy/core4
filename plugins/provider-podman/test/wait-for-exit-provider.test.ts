import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DateTime, Effect } from "effect";

import { makePluginStateStore } from "@lando/core/testing";
import { ownerOnlyFileAccess } from "@lando/engine/services/private-file-access";
import { type PodmanApiClient, makeRuntimeProvider } from "@lando/provider-podman";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  ProviderId,
  ServiceName,
  type ServicePlan,
} from "@lando/sdk/schema";
import { makeStateStore } from "@lando/state-store/service";
import { persistAppliedPlan } from "../src/applied-state.ts";

const providerId = ProviderId.make("podman");
const appId = AppId.make("podman-wait-app");
const serviceName = ServiceName.make("job");
const metadata = {
  resolvedAt: DateTime.unsafeMake("2026-07-26T00:00:00Z"),
  source: "provider-podman/wait-for-exit.test.ts",
  runtime: 4 as const,
};

const servicePlan: ServicePlan = {
  name: serviceName,
  type: "compose",
  provider: providerId,
  primary: true,
  artifact: { kind: "ref", ref: "busybox:1.37" },
  environment: {},
  mounts: [],
  storage: [],
  endpoints: [],
  routes: [],
  dependsOn: [],
  hostAliases: [],
  metadata,
  extensions: {},
};

const plan: AppPlan = {
  id: appId,
  name: "Podman Wait App",
  slug: "podman-wait-app",
  root: AbsolutePath.make("/tmp/podman-wait-app"),
  provider: providerId,
  services: { [serviceName]: servicePlan },
  routes: [],
  networks: [],
  stores: [],
  fileSync: [],
  metadata,
  extensions: {},
};

test("waitForExit forwards cancellation to the Podman wait request", async () => {
  const stateDir = await mkdtemp(join(tmpdir(), "lando-provider-podman-wait-"));
  const controller = new AbortController();
  let observedSignal: AbortSignal | undefined;
  const podmanApi: PodmanApiClient = {
    info: Effect.succeed({ host: { arch: "x64" }, version: { Version: "6.0.0" } }),
    ping: Effect.void,
    request: (request) =>
      Effect.sync(() => {
        observedSignal = request.signal;
        return { status: 200, body: "0" };
      }),
  };
  try {
    const state = makePluginStateStore(
      makeStateStore({ privateFileAccess: ownerOnlyFileAccess }),
      AbsolutePath.make(stateDir),
    );
    await Effect.runPromise(persistAppliedPlan(state, plan));
    const provider = await Effect.runPromise(
      makeRuntimeProvider({
        podmanApi,
        platform: "linux",
        env: {},
        conflictDetector: () => Effect.void,
        appliedPlanState: state,
      }),
    );

    const result = await Effect.runPromise(
      Effect.scoped(
        provider.waitForExit({ app: appId, service: serviceName }, { signal: controller.signal }),
      ),
    );

    expect(result).toEqual({ exitCode: 0 });
    expect(observedSignal).toBe(controller.signal);
  } finally {
    await rm(stateDir, { recursive: true });
  }
});
