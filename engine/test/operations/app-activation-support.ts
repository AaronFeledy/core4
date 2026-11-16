import type { EngineHttpApi } from "@lando/container-runtime/engine-api";
import { networkOwnershipLabels } from "@lando/container-runtime/native-ownership";
import { bringUp } from "@lando/container-runtime/podman/bring-up";
import { inspect } from "@lando/container-runtime/podman/inspect";
import {
  fixtureContainerLabels,
  fixtureHelperOptions,
} from "@lando/container-runtime/testing/exec-supervision";
import {
  type AppPlan,
  type FileSyncSessionInfo,
  landoAppNetworkName,
  landoSharedNetworkName,
} from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Effect } from "effect";
import { serviceWithArtifact } from "../../src/services/build-artifact-runner.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

export const recordingFileSync = (sessions: FileSyncSessionInfo[], calls: string[]) => ({
  ...TestFileSyncEngine,
  id: "mutagen",
  sessionsPersistAcrossProcesses: true,
  isAvailable: Effect.succeed(true),
  listSessions: () => Effect.sync(() => sessions),
  appLifecycle: {
    disposalPhase: () => Effect.succeed("active" as const),
    invalidateDrain: () => Effect.sync(() => void calls.push("invalidate")),
    drain: () => Effect.sync(() => void calls.push("drain")),
    dispose: () =>
      Effect.sync(() => {
        calls.push("dispose");
        sessions.splice(0);
      }),
    completeDisposal: () => Effect.void,
  },
});

export const secretRestartHarness = () => {
  const service = serviceWithArtifact(
    {
      ...web,
      environment: {
        TOKEN: { _tag: "SecretRef", reference: "API_TOKEN" },
      },
    },
    { providerId: plan.provider, ref: "node:22-alpine" },
  );
  const desired: AppPlan = { ...plan, services: { [web.name]: service } };
  const mutations: string[] = [];
  let resolutions = 0;
  let running = true;
  const privateNetwork = landoAppNetworkName(desired);
  const sharedNetwork = landoSharedNetworkName(desired);
  if (privateNetwork === undefined || sharedNetwork === undefined)
    throw new TypeError("Missing fixture networks");
  const api: EngineHttpApi = {
    request: (request) =>
      Effect.sync(() => {
        if (request.method === "GET" && request.path === `/networks/${encodeURIComponent(privateNetwork)}`)
          return {
            status: 200,
            body: JSON.stringify({
              Id: "private",
              Name: privateNetwork,
              Driver: "bridge",
              Labels: networkOwnershipLabels(desired),
            }),
          };
        if (request.method === "GET" && request.path === `/networks/${encodeURIComponent(sharedNetwork)}`)
          return { status: 200, body: "{}" };
        if (request.method === "GET" && request.path.endsWith("/json"))
          return {
            status: 200,
            body: JSON.stringify({
              Id: "retained",
              Config: { Labels: fixtureContainerLabels(desired, service) },
              State: { Running: running },
              Mounts: [],
            }),
          };
        if (request.method === "POST" && request.path.endsWith("/start")) {
          running = true;
          mutations.push("start");
          return { status: 204, body: "" };
        }
        throw new TypeError(`Unexpected restart request: ${request.method} ${request.path}`);
      }),
  };
  const ctx = { providerId: "lando", remediation: "Retry.", env: {} };
  const harness = makeHarness({
    plannedApp: desired,
    secretStore: {
      id: "counting",
      get: () =>
        Effect.sync(() => {
          resolutions += 1;
          return "canary";
        }),
      has: () => Effect.succeed(true),
      list: Effect.succeed(["API_TOKEN"]),
    },
    inspect: (target) => inspect(target.plan ?? desired, target, { api, ctx, ...fixtureHelperOptions }),
    onStop: () => {
      running = false;
      mutations.push("stop");
    },
    apply: (plan, options) => {
      const resolveServiceEnvironment = options.resolveServiceEnvironment;
      if (resolveServiceEnvironment === undefined) return Effect.die("Missing creation resolver");
      return bringUp(plan, {
        ...fixtureHelperOptions,
        ...options,
        api,
        ctx,
        resolveServiceEnvironment,
        ensureImage: () => Effect.die("Selected restart must not pull"),
      });
    },
  });
  return { ...harness, desired, mutations, resolutions: () => resolutions };
};
