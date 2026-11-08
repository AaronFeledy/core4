import { rm } from "node:fs/promises";
import type { AppPlan, ServiceHomePlan } from "@lando/sdk/schema";
import { PortablePath } from "@lando/sdk/schema";
import { RuntimeProviderRegistry } from "@lando/sdk/services";
import { Effect } from "effect";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import {
  publishVolumeTransitionNotices,
  withVolumeTransitionNotices,
} from "../../src/operations/volume-transition-notice.ts";
import { byTag, makeHarness, plan, web } from "./start-progress-topology-support.ts";

export const previousHome = {
  state: "persisted",
  target: "/home/node",
  store: "lando-test-web-home-node-old",
  user: "node",
} as const;
export const withHome = (home?: ServiceHomePlan): AppPlan => ({
  ...plan,
  services: {
    [web.name]: {
      ...web,
      serviceTypeId: "node",
      ...(home === undefined ? {} : { home }),
      mounts:
        home?.state === "persisted"
          ? [
              {
                type: "volume",
                origin: "derived",
                target: PortablePath.make(home.target),
                store: home.store,
                readOnly: false,
              },
            ]
          : [],
    },
  },
});
export const paths = ["start", "rebuild", "selected rebuild", "restart", "selected restart"] as const;
type CommandPath = (typeof paths)[number];

export const runNotice = async (previous: AppPlan, desired: AppPlan) => {
  const harness = makeHarness({ plannedApp: desired });
  try {
    await Effect.runPromise(
      withVolumeTransitionNotices(publishVolumeTransitionNotices(previous, desired)).pipe(
        Effect.provide(harness.layer),
      ),
    );
    return byTag(harness.events, "message.warn");
  } finally {
    await rm(harness.userDataRoot, { recursive: true, force: true });
  }
};

export const runTransition = async (
  path: CommandPath,
  previous: AppPlan | undefined,
  desired: AppPlan,
  repeats = 1,
) => {
  let appliedReads = 0;
  const timeline: string[] = [];
  const harness = makeHarness({
    plannedApp: desired,
    onApply: () => {
      timeline.push("apply");
    },
    onPublish: (event) =>
      Effect.sync(() => {
        if (event._tag === "message.warn") timeline.push("warn");
      }),
  });
  const target = {
    plan: desired,
    root: desired.root,
    app: { kind: "user" as const, id: desired.id, root: desired.root },
  };
  const operation = () => {
    switch (path) {
      case "start":
        return startApp({}, target);
      case "rebuild":
        return rebuildApp({}, target);
      case "selected rebuild":
        return rebuildApp({ services: [web.name] }, target);
      case "restart":
        return restartApp({}, target);
      case "selected restart":
        return restartApp({ services: [web.name] }, target);
      default: {
        const unreachable: never = path;
        return unreachable;
      }
    }
  };
  try {
    await Effect.runPromise(
      Effect.forEach(Array.from({ length: repeats }), operation).pipe(
        Effect.provideService(RuntimeProviderRegistry, {
          ...harness.runtimeProviderRegistry,
          appliedPlansFor: () => Effect.succeed(previous === undefined ? [] : [previous]),
          resolveAppliedPlan: () =>
            Effect.sync(() => {
              appliedReads++;
              return previous;
            }),
        }),
        Effect.provide(harness.layer),
      ),
    );
    return { warnings: byTag(harness.events, "message.warn"), timeline, appliedReads };
  } finally {
    await rm(harness.userDataRoot, { recursive: true, force: true });
  }
};
