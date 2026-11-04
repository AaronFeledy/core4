import { describe, expect, test } from "bun:test";
import { FileSyncStartError } from "@lando/sdk/errors";
import {
  AbsolutePath,
  AppId,
  type AppPlan,
  type FileSyncSessionInfo,
  FileSyncSessionRef,
  type FileSyncSessionSpec,
  PortablePath,
  ProviderId,
  ServiceName,
  fileSyncVolumeName,
} from "@lando/sdk/schema";
import type { FileSyncEngineShape } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Cause, DateTime, Deferred, Effect, Exit, Fiber, Option, Scope } from "effect";
import { startFileSyncSessions } from "../../src/operations/start-file-sync.ts";
import { provideFileSyncEngine } from "../file-sync-engine.ts";
import { web } from "./start-progress-topology-support.ts";

const root = AbsolutePath.make("/tmp/durable-sync-contract");
const app = { kind: "user" as const, id: AppId.make("durable-sync-contract"), root };
const spec = (mountKey: string): FileSyncSessionSpec => ({
  app,
  service: ServiceName.make("web"),
  mountKey,
  source: root,
  target: {
    _tag: "volume",
    name: fileSyncVolumeName(app.id, "web", mountKey),
    path: PortablePath.make(`/${mountKey}`),
  },
  mode: "two-way-safe",
  excludes: [".git"],
});
const plan: AppPlan = {
  id: AppId.make(app.id),
  name: app.id,
  slug: app.id,
  root,
  provider: ProviderId.make("lando"),
  services: {
    [web.name]: {
      ...web,
      mounts: ["first", "second"].map((mountKey) => ({
        type: "bind" as const,
        source: root,
        target: PortablePath.make(`/${mountKey}`),
        readOnly: false,
        realization: "accelerated" as const,
        mountKey,
      })),
    },
  },
  routes: [],
  stores: [],
  fileSync: ["first", "second"].map((mountKey) => ({ engineId: "mutagen", session: spec(mountKey) })),
  metadata: {
    source: "durable-sync-test",
    runtime: 4,
    resolvedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
  },
  extensions: {},
};
const events = { publish: () => Effect.void };

const fixture = () => {
  const sessions = new Map<FileSyncSessionRef, FileSyncSessionInfo>();
  const cleanup: string[] = [];
  const record = (session: FileSyncSessionSpec) => {
    const ref = FileSyncSessionRef.make(`sync-${session.mountKey}`);
    sessions.set(ref, {
      ref,
      app,
      service: session.service,
      mountKey: session.mountKey,
      spec: session,
      status: "running",
      lastUpdatedAt: DateTime.makeUnsafe("2026-10-13T00:00:00Z"),
    });
    return ref;
  };
  const engine: FileSyncEngineShape = {
    ...TestFileSyncEngine,
    id: "mutagen",
    sessionsPersistAcrossProcesses: true,
    isAvailable: Effect.succeed(true),
    createSession: (session) => Effect.sync(() => record(session)),
    listSessions: (filter) =>
      Effect.sync(() =>
        [...sessions.values()].filter(
          (session) => filter.mountKey === undefined || session.mountKey === filter.mountKey,
        ),
      ),
    flushSession: () => Effect.void,
    pauseSession: () =>
      Effect.sync(() => {
        cleanup.push("pause");
      }),
    terminateSession: (ref) =>
      Effect.sync(() => {
        cleanup.push("terminate");
        sessions.delete(ref);
      }),
    appLifecycle: {
      invalidateDrain: () => Effect.void,
      drain: () =>
        Effect.sync(() => {
          cleanup.push("drain");
        }),
      dispose: () => Effect.void,
      completeDisposal: () => Effect.void,
      disposalPhase: () => Effect.succeed("active"),
    },
  };
  return { sessions, cleanup, record, engine };
};

describe("durable initial file-sync failure", () => {
  for (const managed of [false, true]) {
    for (const failureAt of ["create", "flush"] as const) {
      test(`preserves both sessions after second ${failureAt} fails (managed=${managed})`, async () => {
        const state = fixture();
        const scope = await Effect.runPromise(Scope.make());
        const failure = new FileSyncStartError({
          engineId: "mutagen",
          message: "second session readiness failed",
          remediation: "Fix the reported file-sync session failure, then retry `lando start`.",
        });
        const engine: FileSyncEngineShape = {
          ...state.engine,
          createSession: (session) =>
            Effect.sync(() => state.record(session)).pipe(
              Effect.flatMap((ref) =>
                failureAt === "create" && session.mountKey === "second"
                  ? Effect.fail(failure)
                  : Effect.succeed(ref),
              ),
            ),
          flushSession: (ref) =>
            failureAt === "flush" && ref === "sync-second" ? Effect.fail(failure) : Effect.void,
        };
        try {
          const exit = await Effect.runPromiseExit(
            startFileSyncSessions(plan, events, managed ? { scope } : undefined).pipe(
              provideFileSyncEngine(engine),
            ),
          );
          expect(Exit.isFailure(exit)).toBe(true);
          if (Exit.isFailure(exit))
            expect(Option.getOrThrow(Cause.findErrorOption(exit.cause))).toBe(failure);
          expect([...state.sessions.keys()].map(String)).toEqual(["sync-first", "sync-second"]);
          expect(state.cleanup).toEqual([]);
        } finally {
          await Effect.runPromise(Scope.close(scope, Exit.void));
        }
      });
    }
  }

  test("cancellation interrupts long initial readiness and preserves its committed session", async () => {
    const state = fixture();
    const entered = await Effect.runPromise(Deferred.make<void>());
    const release = await Effect.runPromise(Deferred.make<void>());
    const scope = await Effect.runPromise(Scope.make());
    const engine: FileSyncEngineShape = {
      ...state.engine,
      createSession: (session) =>
        Effect.gen(function* () {
          const ref = state.record(session);
          yield* Deferred.succeed(entered, undefined);
          yield* Deferred.await(release);
          return ref;
        }),
    };
    const fiber = Effect.runFork(
      startFileSyncSessions(
        {
          ...plan,
          fileSync: plan.fileSync.slice(0, 1),
          services: {
            [web.name]: {
              ...web,
              mounts: [
                {
                  type: "bind",
                  source: root,
                  target: PortablePath.make("/first"),
                  readOnly: false,
                  realization: "accelerated",
                  mountKey: "first",
                },
              ],
            },
          },
        },
        events,
        { scope },
      ).pipe(provideFileSyncEngine(engine)),
    );
    try {
      await Effect.runPromise(Deferred.await(entered));
      const interrupted = await Effect.runPromise(
        Fiber.interrupt(fiber).pipe(Effect.andThen(Fiber.await(fiber)), Effect.timeoutOption("500 millis")),
      );
      expect(Option.isSome(interrupted)).toBe(true);
      if (Option.isSome(interrupted)) {
        expect(Exit.isFailure(interrupted.value)).toBe(true);
        if (Exit.isFailure(interrupted.value))
          expect(Cause.hasInterrupts(interrupted.value.cause)).toBe(true);
      }
      expect([...state.sessions.keys()].map(String)).toEqual(["sync-first"]);
      expect(state.cleanup).toEqual([]);
    } finally {
      await Effect.runPromise(Deferred.succeed(release, undefined));
      await Effect.runPromise(Fiber.interrupt(fiber));
      await Effect.runPromise(Scope.close(scope, Exit.void));
    }
  });
});
