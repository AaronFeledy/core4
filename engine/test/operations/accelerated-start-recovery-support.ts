import { FileSyncStartError } from "@lando/sdk/errors";
import {
  AbsoluteContainerPath,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  PortablePath,
} from "@lando/sdk/schema";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Cause, DateTime, Effect } from "effect";
import { beginAcceleratedStart } from "../../src/operations/accelerated-start-journal.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

export const app = { kind: "user", id: plan.id, root: plan.root } as const;
export const session = {
  app,
  service: web.name,
  mountKey: "app-mount",
  source: plan.root,
  target: { _tag: "volume", name: "test-start-web-app-mount", path: PortablePath.make("/app") },
  mode: "two-way-safe",
  excludes: [],
} as const;
export const acceleratedPlan: AppPlan = {
  ...plan,
  services: {
    [web.name]: {
      ...web,
      appMount: {
        source: plan.root,
        target: PortablePath.make("/app"),
        readOnly: false,
        realization: "accelerated",
        excludes: [],
        includes: [],
      },
    },
  },
  fileSync: [{ engineId: "mutagen", session }],
};
export const target = { plan: acceleratedPlan, root: plan.root, app };

export const recoveryHarness = Effect.fnUntraced(function* (
  options: {
    readonly replica?: boolean;
    readonly extraSession?: boolean;
    readonly failFlush?: boolean;
    readonly phase?: "retained" | "preparing";
    readonly appliedState?: "unknown";
    readonly changedVolume?: boolean;
  } = {},
) {
  const calls: string[] = [];
  const sessions: FileSyncSessionInfo[] = [
    {
      ...session,
      ref: FileSyncSessionRef.make("old"),
      spec: session,
      status: "running",
      lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
    },
  ];
  if (options.extraSession)
    sessions.push({
      ...session,
      mountKey: "unknown",
      ref: FileSyncSessionRef.make("unknown"),
      spec: { ...session, mountKey: "unknown" },
      status: "running",
      lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
    });
  const harness = makeHarness({
    plannedApp: acceleratedPlan,
    providerHasFileSyncRollback: false,
    ...(options.appliedState === undefined ? {} : { appliedFileSyncState: options.appliedState }),
    ...(options.changedVolume
      ? {
          preparedFileSyncTargets: () => [
            {
              session,
              endpoint: {
                _tag: "container" as const,
                containerId: "helper",
                path: AbsoluteContainerPath.make("/sync"),
                volumeName: "another-volume",
              },
            },
          ],
        }
      : {}),
    onPrepareFileSync: () => {
      calls.push("prepare");
    },
    onDestroy: (_target, opts) => {
      calls.push(`destroy:${opts?.volumes}`);
    },
    fileSync: {
      ...TestFileSyncEngine,
      id: "mutagen",
      isAvailable: Effect.succeed(true),
      sessionsPersistAcrossProcesses: true,
      capabilities: {
        ...TestFileSyncEngine.capabilities,
        modes: options.replica === false ? ["two-way-safe"] : ["two-way-safe", "one-way-replica"],
      },
      listSessions: () => Effect.sync(() => [...sessions]),
      createSession: (spec) =>
        Effect.sync(() => {
          calls.push(`create:${spec.mode}`);
          const ref = FileSyncSessionRef.make(spec.mode);
          sessions.push({
            ...spec,
            ref,
            spec,
            status: "running",
            lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
          });
          return ref;
        }),
      flushSession: (ref) =>
        Effect.sync(() => {
          calls.push(`flush:${ref}`);
        }).pipe(
          Effect.andThen(
            options.failFlush
              ? Effect.fail(new FileSyncStartError({ engineId: "mutagen", message: "reseed failed" }))
              : Effect.void,
          ),
        ),
      terminateSession: (ref) =>
        Effect.sync(() => {
          calls.push(`terminate:${ref}`);
          const index = sessions.findIndex((entry) => entry.ref === ref);
          if (index >= 0) sessions.splice(index, 1);
        }),
    },
  });
  yield* beginAcceleratedStart(acceleratedPlan, app).pipe(
    Effect.flatMap((pending) =>
      options.phase === "preparing"
        ? Effect.void
        : pending.retainTargets(
            Cause.fail(new FileSyncStartError({ engineId: "mutagen", message: "failed" })),
          ),
    ),
    Effect.provide(harness.layer),
  );
  return { ...harness, calls, sessions };
});
