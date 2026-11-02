import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AbsolutePath, AppId, type AppPlan } from "@lando/sdk/schema";
import { Effect, Exit } from "effect";
import {
  beginOrResumeAcceleratedStart,
  readPendingAcceleratedStart,
} from "../../src/operations/accelerated-start-journal.ts";
import { destroyApp } from "../../src/operations/destroy.ts";
import { rebuildApp } from "../../src/operations/rebuild.ts";
import { restartApp } from "../../src/operations/restart.ts";
import { startApp } from "../../src/operations/start.ts";
import { stopApp } from "../../src/operations/stop.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import {
  acceleratedPlan,
  app,
  recoveryHarness,
  session,
  target,
} from "./accelerated-start-recovery-support.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("journal hashes the original persisted entries rather than reconstructing the normalized bundle", async () => {
  const original: AppPlan = {
    ...acceleratedPlan,
    fileSync: acceleratedPlan.fileSync.map(({ engineId, session }) => ({ session, engineId })),
  };
  const harness = makeHarness({ plannedApp: original });
  await Effect.runPromise(beginOrResumeAcceleratedStart(original, app).pipe(Effect.provide(harness.layer)));
  const record = await Effect.runPromise(
    readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)),
  );
  expect(record?.mountPlanDigest).toBe(
    new Bun.CryptoHasher("sha256").update(JSON.stringify(original.fileSync)).digest("hex"),
  );
});

test.each(["preparing", "sessions-ready", "apply-intent"] as const)(
  "historical journal resumes the same attempt from %s with unchanged session bytes",
  async (phase) => {
    // Given
    const harness = await Effect.runPromise(recoveryHarness({ phase }));
    const before = await Effect.runPromise(
      readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)),
    );
    if (before === null) throw new Error("Expected historical pending journal");
    const explicit: AppPlan = {
      ...acceleratedPlan,
      fileSync: acceleratedPlan.fileSync.map((entry) => ({ ...entry, session: { ...entry.session } })),
    };
    // When
    const resumed = await Effect.runPromise(
      beginOrResumeAcceleratedStart(explicit, app).pipe(Effect.provide(harness.layer)),
    );
    const pending = await Effect.runPromise(
      readPendingAcceleratedStart(app, explicit).pipe(Effect.provide(harness.layer)),
    );
    // Then
    expect(resumed.attemptId).toBe(before.attemptId);
    expect(resumed.resumedFrom).toBe(phase);
    expect(pending).toEqual(before);
  },
);

test.each(["preparing", "sessions-ready", "apply-intent"] as const)(
  "historical journal rejects changed engine or session identity at %s without altering recovery",
  async (phase) => {
    // Given
    const harness = await Effect.runPromise(recoveryHarness({ phase }));
    const before = await Effect.runPromise(
      readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)),
    );
    for (const change of [
      { engineId: "other" },
      { session: { ...session, excludes: [] } },
      { session: { ...session, source: AbsolutePath.make("/other") } },
    ]) {
      const changed = {
        ...acceleratedPlan,
        fileSync: acceleratedPlan.fileSync.map((entry) => ({ ...entry, ...change })),
      };
      // When
      const result = await Effect.runPromiseExit(
        beginOrResumeAcceleratedStart(changed, app).pipe(Effect.provide(harness.layer)),
      );
      // Then
      expect(Exit.isFailure(result)).toBe(true);
      expect(
        await Effect.runPromise(readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer))),
      ).toEqual(before);
      expect(harness.calls).toEqual([]);
    }
  },
);

test("pending accelerated start blocks changed ordinary plan before every hook or provider action", async () => {
  for (const operation of [startApp, restartApp, rebuildApp, stopApp, destroyApp]) {
    const harness = await Effect.runPromise(recoveryHarness());
    const result = await Effect.runPromiseExit(
      Effect.gen(function* () {
        yield* operation({}, { ...target, plan });
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isFailure(result)).toBe(true);
    expect(harness.calls).toEqual([]);
    expect(harness.events).toEqual([]);
  }
});

test("atomic completed tombstone permits a fresh attempt while stale owners cannot overwrite it", async () => {
  const harness = await Effect.runPromise(recoveryHarness({ phase: "preparing" }));
  const first = await Effect.runPromise(
    beginOrResumeAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  await Effect.runPromise(first.advance("sessions-ready"));
  await Effect.runPromise(first.complete);
  expect(
    await Effect.runPromise(readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer))),
  ).toBeNull();
  const second = await Effect.runPromise(
    beginOrResumeAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  expect(second.attemptId).not.toBe(first.attemptId);
  expect(Exit.isFailure(await Effect.runPromiseExit(first.advance("apply-intent")))).toBe(true);
  const pending = await Effect.runPromise(
    readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)),
  );
  expect(pending?.attemptId).toBe(second.attemptId);
});

test("replayed advances are idempotent and never move a resumed phase backwards", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const resumed = await Effect.runPromise(
    beginOrResumeAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(harness.layer)),
  );
  await Effect.runPromise(resumed.advance("preparing"));
  await Effect.runPromise(resumed.advance("sessions-ready"));
  const pending = await Effect.runPromise(
    readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)),
  );
  expect(pending?.phase).toBe("apply-intent");
});

test("a pending attempt for one root does not block another app with the same ID", async () => {
  const other = await mkdtemp(join(tmpdir(), "lando-journal-other-"));
  try {
    const harness = await Effect.runPromise(recoveryHarness());
    const otherRoot = AbsolutePath.make(other);
    const otherApp = { ...app, root: otherRoot };
    const otherPlan: AppPlan = {
      ...acceleratedPlan,
      root: otherRoot,
      services: Object.fromEntries(
        Object.entries(acceleratedPlan.services).map(([name, service]) => [
          name,
          {
            ...service,
            mounts: service.mounts.map((mount) =>
              mount.type === "bind" ? { ...mount, source: otherRoot } : mount,
            ),
          },
        ]),
      ),
      fileSync: acceleratedPlan.fileSync.map((entry) => ({
        ...entry,
        session: { ...entry.session, app: otherApp, source: otherRoot },
      })),
    };
    expect(
      await Effect.runPromise(readPendingAcceleratedStart(otherApp).pipe(Effect.provide(harness.layer))),
    ).toBeNull();
    const original = await Effect.runPromise(
      readPendingAcceleratedStart(app).pipe(Effect.provide(harness.layer)),
    );
    const independent = await Effect.runPromise(
      beginOrResumeAcceleratedStart(otherPlan, otherApp).pipe(Effect.provide(harness.layer)),
    );
    expect(independent.attemptId).not.toBe(original?.attemptId);
  } finally {
    await rm(other, { recursive: true, force: true });
  }
});

test("rejects mismatched session identity before creating a journal", async () => {
  const store = makeTestStateStore();
  const foreign = { ...app, id: AppId.make("foreign") };
  const changed = {
    ...acceleratedPlan,
    fileSync: acceleratedPlan.fileSync.map((entry) => ({
      ...entry,
      session: { ...entry.session, app: foreign },
    })),
  };
  const result = await Effect.runPromiseExit(
    beginOrResumeAcceleratedStart(changed, app).pipe(Effect.provide(store.layer)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(store.snapshot().size).toBe(0);
});

test("a mismatched resolved target cannot bypass the pending plan journal", async () => {
  const harness = await Effect.runPromise(recoveryHarness());
  const wrong = { ...app, id: AppId.make("foreign") };
  const result = await Effect.runPromiseExit(
    startApp({}, { ...target, app: wrong }).pipe(Effect.provide(harness.layer)),
  );
  expect(Exit.isFailure(result)).toBe(true);
  expect(harness.events).toEqual([]);
  expect(harness.calls).toEqual([]);
});

test("accelerated scratch journal belongs to the captured scratch ref", async () => {
  const store = makeTestStateStore();
  const scratch = { ...app, kind: "scratch" } as const;
  const scratchPlan = {
    ...acceleratedPlan,
    fileSync: acceleratedPlan.fileSync.map((entry) => ({
      ...entry,
      session: { ...entry.session, app: scratch },
    })),
  };
  const first = await Effect.runPromise(
    beginOrResumeAcceleratedStart(scratchPlan, scratch).pipe(Effect.provide(store.layer)),
  );
  expect(
    (
      await Effect.runPromise(
        readPendingAcceleratedStart(scratch, scratchPlan).pipe(Effect.provide(store.layer)),
      )
    )?.attemptId,
  ).toBe(first.attemptId);
  expect(
    await Effect.runPromise(readPendingAcceleratedStart(app).pipe(Effect.provide(store.layer))),
  ).toBeNull();
  expect(
    Exit.isFailure(
      await Effect.runPromiseExit(
        beginOrResumeAcceleratedStart(scratchPlan, app).pipe(Effect.provide(store.layer)),
      ),
    ),
  ).toBe(true);
});

test("pending journal follows a physical root through alias and changed app ID", async () => {
  const root = await mkdtemp(join(tmpdir(), "lando-journal-alias-"));
  try {
    const alias = join(root, "alias");
    await symlink(root, alias, "dir");
    const physical = AbsolutePath.make(root);
    const original = { ...app, root: physical };
    const originalPlan = {
      ...acceleratedPlan,
      root: physical,
      services: Object.fromEntries(
        Object.entries(acceleratedPlan.services).map(([name, service]) => [
          name,
          {
            ...service,
            mounts: service.mounts.map((mount) =>
              mount.type === "bind" ? { ...mount, source: physical } : mount,
            ),
          },
        ]),
      ),
      fileSync: acceleratedPlan.fileSync.map((entry) => ({
        ...entry,
        session: { ...entry.session, app: original, source: physical },
      })),
    };
    const harness = makeHarness();
    await Effect.runPromise(
      beginOrResumeAcceleratedStart(originalPlan, original).pipe(Effect.provide(harness.layer)),
    );
    const result = await Effect.runPromiseExit(
      readPendingAcceleratedStart({
        ...original,
        id: AppId.make("renamed"),
        root: AbsolutePath.make(alias),
      }).pipe(Effect.provide(harness.layer)),
    );
    expect(Exit.isFailure(result)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
