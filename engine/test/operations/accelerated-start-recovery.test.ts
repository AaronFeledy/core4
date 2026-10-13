import { expect, test } from "bun:test";
import { ProviderId } from "@lando/sdk/schema";
import { BuildOrchestrator, EventService } from "@lando/sdk/services";
import { Cause, Effect, Exit, Option } from "effect";
import {
  beginAcceleratedStart,
  readJournal,
  requireNoPendingAcceleratedStart,
} from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp } from "../../src/operations/stop.ts";
import {
  acceleratedPlan,
  app,
  recoveryHarness,
  session,
  target,
} from "./accelerated-start-recovery-support.ts";

test("retained durable start reuses its two-way session and history", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
  if (Exit.isFailure(result)) throw Option.getOrThrow(Cause.findErrorOption(result.cause));
  expect(harness.calls).toEqual(["invalidate", "prepare", "flush:old"]);
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old"]);
  await Effect.runPromise(requireNoPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)));
});

test("unknown retained sessions block init hooks and preserve all sessions", async () => {
  const harness = await Effect.runPromise(recoveryHarness({ extraSession: true }));
  const result = await Effect.runPromiseExit(
    Effect.gen(function* () {
      const events = yield* EventService;
      return yield* startApp({}, target).pipe(
        Effect.provideService(EventService, {
          ...events,
          publish: (event) =>
            Effect.sync(() => {
              if (["pre-init", "post-init", "pre-start"].includes(event._tag)) harness.calls.push(event._tag);
            }).pipe(Effect.andThen(events.publish(event))),
        }),
      );
    }).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).toEqual([]);
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old", "unknown"]);
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe("retained");
});

test("retained start rejects changed mounts before helper or session mutation", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const changed = {
    ...acceleratedPlan,
    fileSync: [{ engineId: "mutagen", session: { ...session, excludes: ["changed"] } }],
  };
  const result = await Effect.runPromiseExit(
    startApp({}, { ...target, plan: changed }).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).toEqual([]);
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old"]);
});

test.each(["stop", "restart", "rebuild"] as const)("%s blocks retained attempts", async (operation) => {
  const harness = await Effect.runPromise(recoveryHarness());
  const operations = {
    stop: stopApp({}, target).pipe(Effect.asVoid),
    restart: restartApp({}, target).pipe(Effect.asVoid),
    rebuild: rebuildApp({}, target).pipe(Effect.asVoid),
  };
  const result = await Effect.runPromiseExit(operations[operation].pipe(Effect.provide(harness.layer)));
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).toEqual([]);
});

test.each([
  { plan: { ...acceleratedPlan, provider: ProviderId.make("other") } },
  { plan: { ...acceleratedPlan, fileSync: [{ engineId: "other", session }] } },
  { plan: { ...acceleratedPlan, fileSync: [] } },
])("retained start rejects changed provider or engine identity", async ({ plan }) => {
  const harness = await Effect.runPromise(recoveryHarness());
  const result = await Effect.runPromiseExit(
    startApp({}, { ...target, plan }).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).not.toContain("terminate:old");
  expect(harness.calls).not.toContain("prepare");
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old"]);
});

test("retained preflight rejects a mismatched initial plan before build", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const staleInitialPlan = {
    ...acceleratedPlan,
    fileSync: [{ engineId: "mutagen", session: { ...session, excludes: ["before-build"] } }],
  };
  const result = await Effect.runPromiseExit(
    startApp({}, { ...target, plan: staleInitialPlan }).pipe(
      Effect.provideService(BuildOrchestrator, {
        build: () => Effect.succeed(acceleratedPlan),
        buildApp: () => Effect.void,
      }),
      Effect.provide(harness.layer),
    ),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).not.toContain("prepare");
  expect(harness.calls).not.toContain("terminate:old");
});

test("failed retained flush keeps the journal and session for safe retry", async () => {
  const harness = await Effect.runPromise(recoveryHarness({ failFlush: true }));
  const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).toContain("flush:old");
  expect(harness.calls).not.toContain("terminate:old");
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe("retained");
  expect(harness.sessions.map(({ ref }) => String(ref))).toEqual(["old"]);
});

test("changed prepared volume leaves durable session and journal untouched", async () => {
  const harness = await Effect.runPromise(recoveryHarness({ changedVolume: true }));
  const result = await Effect.runPromiseExit(startApp({}, target).pipe(Effect.provide(harness.layer)));
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).not.toContain("terminate:old");
  expect(harness.calls).not.toContain("create:one-way-replica");
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe("retained");
});

test("adoption saves a new preparing attempt without mutating the old session", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  const adopted = await Effect.runPromise(
    beginAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(after.pending?.phase).toBe("preparing");
  expect(after.pending?.attemptId).toBe(adopted.attemptId);
  expect(adopted.attemptId).not.toBe(before.pending?.attemptId);
  expect(adopted.retained ?? null).toEqual(before.pending);
  expect(harness.calls).toEqual([]);
});

test("retained destroy drains before session and target disposal", async () => {
  const harness = await Effect.runPromise(recoveryHarness({ appliedState: "unknown" }));
  await Effect.runPromise(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
  expect(harness.calls).toEqual([
    "quiesce-retained",
    "drain",
    "dispose",
    "dispose-targets",
    "complete",
    "destroy:false",
  ]);
  expect(harness.sessions).toEqual([]);
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe("completed");
});

test("retained destroy refuses an existing prepared volume without session history", async () => {
  const harness = await Effect.runPromise(recoveryHarness({ appliedState: "unknown" }));
  harness.sessions.splice(0);
  const result = await Effect.runPromiseExit(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.calls).toEqual(["quiesce-retained"]);
  const { pending } = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(pending?.phase).toBe("retained");
});

test("retained destroy safely cleans partial preparation with no volume or session", async () => {
  const harness = await Effect.runPromise(
    recoveryHarness({
      appliedState: "unknown",
      preparedVolumeNames: [],
    }),
  );
  harness.sessions.splice(0);
  await Effect.runPromise(destroyApp({}, target).pipe(Effect.provide(harness.layer)));
  expect(harness.calls).toEqual(["quiesce-retained", "dispose-targets", "destroy:false"]);
});
