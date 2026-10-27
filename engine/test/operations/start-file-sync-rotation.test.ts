import { expect, test } from "bun:test";
import { type AppPlan, PortablePath } from "@lando/sdk/schema";
import { Cause, Effect, Exit } from "effect";
import {
  beginOrResumeAcceleratedStart,
  readJournal,
} from "../../src/operations/accelerated-start-journal.ts";
import { startApp } from "../../src/operations/start.ts";
import { app } from "./accelerated-start-recovery-support.ts";
import {
  type FailurePoint,
  changedPlan,
  oldPlan,
  rotationHarness,
  syncPlan,
  targetFor,
} from "./start-file-sync-rotation-support.ts";

const tmpfsTarget = PortablePath.make("/app/tmp");

const start = (harness: Effect.Success<ReturnType<typeof rotationHarness>>) =>
  startApp({}, targetFor(harness.desired)).pipe(Effect.provide(harness.layer));

test("rotates the complete old session set before init and preserves named volumes without destroy hooks", async () => {
  const harness = await Effect.runPromise(rotationHarness());
  await Effect.runPromise(start(harness));
  expect(harness.calls).toEqual([
    "quiesce",
    "drain",
    "dispose",
    "targets",
    "complete",
    "retire",
    "init",
    "prepare",
    "create:web",
    "create:worker",
    "apply",
  ]);
  expect(harness.cleanedPlans).toEqual([oldPlan]);
  expect(harness.sessions.map(({ spec }) => spec)).toEqual(
    changedPlan.fileSync.map(({ session }) => session),
  );
  expect(harness.applied()?.fileSync).toEqual(changedPlan.fileSync);
  expect(harness.events.filter(({ _tag }) => _tag === "message.info")).toHaveLength(1);
  expect(harness.events.some(({ _tag }) => _tag === "pre-destroy" || _tag === "post-destroy")).toBe(false);
  const journal = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
  expect(journal.pending?.phase).toBe("completed");
});

test.each(["includes", "tmpfs", "store", "source", "removed-session"] as const)(
  "rotates app-wide when %s changes the planned session set",
  async (change) => {
    const desired: AppPlan = syncPlan({
      ...oldPlan,
      services: Object.fromEntries(
        Object.entries(oldPlan.services).map(([name, service]) => [
          name,
          {
            ...service,
            mounts:
              change === "removed-session" && name === "worker"
                ? []
                : [
                    ...service.mounts.map((mount) =>
                      mount.type !== "bind"
                        ? mount
                        : {
                            ...mount,
                            ...(change === "includes" ? { includes: [".git"] } : {}),
                            ...(change === "source" ? { source: `${oldPlan.root}/moved` } : {}),
                          },
                    ),
                    ...(change === "tmpfs"
                      ? [{ type: "tmpfs" as const, target: tmpfsTarget, readOnly: false }]
                      : []),
                    ...(change === "store"
                      ? [
                          {
                            type: "volume" as const,
                            store: "data",
                            target: PortablePath.make("/app/data"),
                            readOnly: false,
                          },
                        ]
                      : []),
                  ],
          },
        ]),
      ),
    });
    const harness = await Effect.runPromise(rotationHarness({ desired }));
    await Effect.runPromise(start(harness));
    expect(harness.cleanedPlans).toEqual([oldPlan]);
    expect(harness.sessions.map(({ spec }) => spec)).toEqual(desired.fileSync.map(({ session }) => session));
  },
);

test.each(["quiesce", "drain", "conflict"] as const)(
  "%s failure preserves old history and targets and permits retry",
  async (failAt) => {
    const harness = await Effect.runPromise(rotationHarness({ failAt }));
    const failed = await Effect.runPromiseExit(start(harness));
    expect(Exit.isFailure(failed)).toBe(true);
    expect(harness.sessions.map(({ spec }) => spec)).toEqual(oldPlan.fileSync.map(({ session }) => session));
    expect(harness.cleanedPlans).toEqual([]);
    expect(harness.applied()).toBe(oldPlan);
    expect(await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)))).toMatchObject({
      pending: null,
    });
    await Effect.runPromise(start(harness));
    expect(harness.sessions.every(({ ref }) => ref.startsWith("new-"))).toBe(true);
  },
);

test.each(["dispose", "targets", "complete"] as const)(
  "%s interruption resumes disposing without requiring the deleted live sessions",
  async (failAt) => {
    const harness = await Effect.runPromise(rotationHarness({ failAt }));
    const failed = await Effect.runPromiseExit(start(harness));
    expect(Exit.isFailure(failed) && Cause.hasInterrupts(failed.cause)).toBe(true);
    expect(harness.phase()).toBe("disposing");
    expect(harness.applied()).toBe(oldPlan);
    harness.calls.splice(0);
    await Effect.runPromise(start(harness));
    expect(harness.calls).not.toContain("drain");
    expect(harness.sessions.map(({ spec }) => spec)).toEqual(
      changedPlan.fileSync.map(({ session }) => session),
    );
  },
);

test("completed disposal with old applied record finishes retirement without restarting old writers", async () => {
  const harness = await Effect.runPromise(rotationHarness({ failAt: "retire" }));
  const failed = await Effect.runPromiseExit(start(harness));
  expect(Exit.isFailure(failed) && Cause.hasInterrupts(failed.cause)).toBe(true);
  expect(harness.phase()).toBe("completed");
  expect(harness.sessions).toHaveLength(0);
  expect(harness.applied()).toBe(oldPlan);
  harness.calls.splice(0);
  await Effect.runPromise(start(harness));
  expect(harness.calls).toEqual(["retire", "init", "prepare", "create:web", "create:worker", "apply"]);
});

test("retired state without a replacement journal starts fresh from the drained host", async () => {
  const harness = await Effect.runPromise(rotationHarness({ failAt: "retire-after" }));
  expect(Exit.isFailure(await Effect.runPromiseExit(start(harness)))).toBe(true);
  expect(harness.applied()).toBeUndefined();
  expect((await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)))).pending).toBeNull();
  harness.calls.splice(0);
  await Effect.runPromise(start(harness));
  expect(harness.calls).toEqual(["init", "prepare", "create:web", "create:worker", "apply"]);
});

test.each(["prepare", "flush"] satisfies FailurePoint[])(
  "replacement journal after %s interruption resumes the recorded attempt",
  async (failAt) => {
    const harness = await Effect.runPromise(rotationHarness({ failAt }));
    expect(Exit.isFailure(await Effect.runPromiseExit(start(harness)))).toBe(true);
    const before = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(before.pending?.phase).toBe("preparing");
    harness.calls.splice(0);
    await Effect.runPromise(start(harness));
    const after = await Effect.runPromise(readJournal(app).pipe(Effect.provide(harness.layer)));
    expect(after.pending).toMatchObject({ attemptId: before.pending?.attemptId, phase: "completed" });
    expect(harness.calls).not.toContain("dispose");
    expect(harness.calls.includes("invalidate")).toBe(failAt === "flush");
    expect(harness.sessions).toHaveLength(2);
  },
);

test.each(["extraSession", "missingSession"] as const)(
  "%s blocks rotation before any mutation",
  async (option) => {
    const harness = await Effect.runPromise(rotationHarness({ [option]: true }));
    expect(Exit.isFailure(await Effect.runPromiseExit(start(harness)))).toBe(true);
    expect(harness.calls).toEqual([]);
    expect(harness.applied()).toBe(oldPlan);
  },
);

test("unchanged sessions reuse history without disposing targets", async () => {
  const harness = await Effect.runPromise(rotationHarness({ desired: oldPlan }));
  await Effect.runPromise(start(harness));
  expect(harness.sessions.every(({ ref }) => ref.startsWith("old-"))).toBe(true);
  expect(harness.cleanedPlans).toEqual([]);
  expect(harness.calls).toEqual(["invalidate", "init", "prepare", "apply"]);
});

test("unfinished old attempt retains its identity restrictions before rotation", async () => {
  const harness = await Effect.runPromise(rotationHarness());
  await Effect.runPromise(beginOrResumeAcceleratedStart(oldPlan, app).pipe(Effect.provide(harness.layer)));
  expect(Exit.isFailure(await Effect.runPromiseExit(start(harness)))).toBe(true);
  expect(harness.calls).toEqual([]);
  expect(harness.sessions.every(({ ref }) => ref.startsWith("old-"))).toBe(true);
});
