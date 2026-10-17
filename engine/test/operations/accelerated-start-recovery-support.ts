import { FileSyncStartError } from "@lando/sdk/errors";
import {
  AbsoluteContainerPath,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
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
        syncExcludes: [],
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
    readonly preparedVolumeNames?: readonly string[];
    readonly cleanupHooks?: boolean;
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
  let phase: "active" | "drained" | "disposing" | "completed" = "active";
  const fileSync = {
    ...TestFileSyncEngine,
    id: "mutagen",
    isAvailable: Effect.succeed(true),
    sessionsPersistAcrossProcesses: true,
    capabilities: {
      ...TestFileSyncEngine.capabilities,
      modes:
        options.replica === false
          ? (["two-way-safe"] as const)
          : (["two-way-safe", "one-way-replica"] as const),
    },
    appLifecycle: {
      invalidateDrain: () => Effect.sync(() => calls.push("invalidate")),
      drain: () =>
        Effect.sync(() => {
          calls.push("drain");
          phase = "drained";
        }),
      dispose: () =>
        Effect.sync(() => {
          calls.push("dispose");
          sessions.splice(0);
          phase = "disposing";
        }),
      completeDisposal: () =>
        Effect.sync(() => {
          calls.push("complete");
          phase = "completed";
        }),
      disposalPhase: () =>
        Effect.sync(() => (phase === "active" && sessions.length === 0 ? ("absent" as const) : phase)),
    },
    listSessions: () => Effect.sync(() => [...sessions]),
    createSession: (spec: FileSyncSessionSpec) =>
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
    flushSession: (ref: FileSyncSessionRef) =>
      Effect.sync(() => {
        calls.push(`flush:${ref}`);
      }).pipe(
        Effect.andThen(
          options.failFlush
            ? Effect.fail(new FileSyncStartError({ engineId: "mutagen", message: "flush failed" }))
            : Effect.void,
        ),
      ),
    pauseSession: (ref: FileSyncSessionRef) =>
      Effect.sync(() => {
        calls.push(`pause:${ref}`);
      }),
    resumeSession: (ref: FileSyncSessionRef) =>
      Effect.sync(() => {
        calls.push(`resume:${ref}`);
      }),
    terminateSession: (ref: FileSyncSessionRef) =>
      Effect.sync(() => {
        calls.push(`terminate:${ref}`);
        const index = sessions.findIndex((entry) => entry.ref === ref);
        if (index >= 0) sessions.splice(index, 1);
      }),
  };
  const durableEngine = {
    ...fileSync,
    bindPreparedTargets: () => Effect.succeed({ ...fileSync, boundApp: app }),
  };
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
    ...(options.cleanupHooks === false
      ? {}
      : {
          quiesceRetainedFileSync: () =>
            Effect.sync(() => {
              calls.push("quiesce-retained");
              return { preparedVolumeNames: options.preparedVolumeNames ?? [session.target.name] };
            }),
          disposeFileSyncTargets: () =>
            Effect.sync(() => {
              calls.push("dispose-targets");
            }),
        }),
    fileSync: durableEngine,
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
