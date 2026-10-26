import { FileSyncStartError, FileSyncStopError } from "@lando/sdk/errors";
import {
  AbsoluteContainerPath,
  type AppPlan,
  type FileSyncSessionFilter,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  PortablePath,
} from "@lando/sdk/schema";
import type { FileSyncEngineShape } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { DateTime, Effect, Option } from "effect";
import { beginOrResumeAcceleratedStart } from "../../src/operations/accelerated-start-journal.ts";
import { makeHarness, plan, web } from "./start-progress-topology-support.ts";

export const app = { kind: "user", id: plan.id, root: plan.root } as const;
export const session = {
  app,
  service: web.name,
  mountKey: "app-mount",
  source: plan.root,
  target: { _tag: "volume", name: "test-start-web-app-mount", path: PortablePath.make("/app") },
  mode: "two-way-safe",
  excludes: [".git"],
} as const;
export const acceleratedPlan: AppPlan = {
  ...plan,
  services: {
    [web.name]: {
      ...web,
      mounts: [
        {
          type: "bind",
          role: "app",
          source: plan.root,
          target: PortablePath.make("/app"),
          readOnly: false,
          realization: "accelerated",
          excludes: [],
          includes: [],
          mountKey: "app-mount",
        },
      ],
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
    readonly phase?: "preparing" | "sessions-ready" | "apply-intent";
    readonly appliedState?: "unknown";
    readonly changedVolume?: boolean;
    readonly preparedVolumeNames?: readonly string[];
    readonly cleanupHooks?: boolean;
    readonly engineOverrides?: Partial<FileSyncEngineShape>;
    readonly harnessOptions?: Parameters<typeof makeHarness>[0];
    readonly recoverMissing?: "none" | "history";
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
      // Mirrors Mutagen: an app with no owned sessions has nothing to drain.
      drain: () =>
        sessions.length === 0
          ? Effect.fail(
              new FileSyncStopError({
                engineId: "mutagen",
                sessionRef: String(app.id),
                message: "App has no Mutagen sessions to drain.",
                remediation: "Skip drain when the app owns no sessions, or create sessions before draining.",
              }),
            )
          : Effect.sync(() => {
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
    listSessions: (filter: FileSyncSessionFilter) =>
      Effect.sync(() =>
        sessions.filter(
          (entry) =>
            (filter.mountKey === undefined || entry.mountKey === filter.mountKey) &&
            (filter.service === undefined || entry.service === filter.service),
        ),
      ),
    ...(options.recoverMissing === undefined
      ? {}
      : {
          recoverSession: (spec: FileSyncSessionSpec) =>
            Effect.sync(() => {
              calls.push("recover");
              if (options.recoverMissing === "none") return Option.none();
              const ref = FileSyncSessionRef.make("recovered");
              sessions.push({
                ...spec,
                ref,
                spec,
                status: "running",
                lastUpdatedAt: DateTime.makeUnsafe("2026-01-01"),
              });
              return Option.some(ref);
            }),
        }),
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
            ? Effect.fail(
                new FileSyncStartError({
                  engineId: "mutagen",
                  message: "flush failed",
                  remediation:
                    "Retry the flush; if it keeps failing, leave the session running and inspect Mutagen session status before stop.",
                }),
              )
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
    ...options.engineOverrides,
    bindPreparedTargets: () => Effect.succeed({ ...fileSync, ...options.engineOverrides, boundApp: app }),
  };
  const harness = makeHarness({
    persistAppliedFileSync: true,
    plannedApp: acceleratedPlan,
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
    ...options.harnessOptions,
  });
  yield* beginOrResumeAcceleratedStart(acceleratedPlan, app).pipe(
    Effect.flatMap((pending) =>
      options.phase === "preparing" ? Effect.void : pending.advance(options.phase ?? "apply-intent"),
    ),
    Effect.provide(harness.layer),
  );
  return { ...harness, calls, sessions };
});
