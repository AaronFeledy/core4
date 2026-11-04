import { expect, test } from "bun:test";
import { FileSyncStartError } from "@lando/sdk/errors";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Effect } from "effect";
import { resolveFileSyncMountPlan } from "../../src/operations/file-sync-plan.ts";
import { startApp } from "../../src/operations/start.ts";
import { FileSyncResolver } from "../../src/plugins/file-sync-resolver.ts";
import { provideFileSyncEngine } from "../file-sync-engine.ts";
import { acceleratedPlan, app } from "./accelerated-start-recovery-support.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

test.each(["module load", "factory construction", "capability disagreement"])(
  "failed %s cannot be swallowed by ordinary fallback or run start hooks",
  async (failureKind) => {
    // Given
    const failure = new FileSyncStartError({
      engineId: "mutagen",
      message: failureKind,
      remediation: "Repair plugin",
    });
    const calls: string[] = [];
    const resolver = FileSyncResolver.of({
      candidates: [],
      select: () => Effect.die("A recorded plan must acquire its own engine"),
      acquire: () => Effect.fail(failure),
    });
    const harness = makeHarness({
      plannedApp: acceleratedPlan,
      onApply: () => calls.push("apply"),
      onPrepareFileSync: () => calls.push("prepare"),
    });
    // When
    const resolved = await Effect.runPromise(
      Effect.result(
        resolveFileSyncMountPlan(acceleratedPlan, () =>
          Effect.sync(() => {
            calls.push("inspect");
            return { status: "missing" as const };
          }),
        ).pipe(Effect.provideService(FileSyncResolver, resolver)),
      ),
    );
    const started = await Effect.runPromise(
      Effect.result(
        startApp({}, { app, plan: acceleratedPlan, root: app.root }).pipe(
          Effect.provide(harness.layer),
          Effect.provideService(FileSyncResolver, resolver),
        ),
      ),
    );
    // Then
    expect(resolved._tag).toBe("Failure");
    if (resolved._tag === "Failure") expect(resolved.failure).toBe(failure);
    expect(started._tag).toBe("Failure");
    if (started._tag === "Failure") expect(started.failure).toBe(failure);
    expect(calls).toEqual([]);
    expect(harness.events).toEqual([]);
  },
);

test.each([{ modes: ["one-way-safe"] as const }, { exclusionPatterns: false }])(
  "capability mismatch cannot downgrade to ordinary mounts (%j)",
  async (capabilities) => {
    // Given
    let inspected = false;
    // When
    const result = await Effect.runPromise(
      Effect.result(
        resolveFileSyncMountPlan(acceleratedPlan, () =>
          Effect.sync(() => {
            inspected = true;
            return { status: "missing" as const };
          }),
        ).pipe(
          provideFileSyncEngine({
            ...TestFileSyncEngine,
            id: "mutagen",
            capabilities: { ...TestFileSyncEngine.capabilities, ...capabilities },
            isAvailable: Effect.succeed(false),
          }),
        ),
      ),
    );
    // Then
    expect(result._tag).toBe("Failure");
    expect(inspected).toBe(false);
  },
);

test.each(["missing", "ordinary", "accelerated", "unknown"] as const)(
  "planned unavailable acceleration fails closed regardless of prior state (%s)",
  async (status) => {
    // Given
    const engine = { ...TestFileSyncEngine, id: "mutagen", isAvailable: Effect.succeed(false) };
    // When
    const result = await Effect.runPromise(
      Effect.result(
        resolveFileSyncMountPlan(acceleratedPlan, () =>
          Effect.succeed(
            status === "accelerated"
              ? {
                  status,
                  engineId: "mutagen",
                  sessions: acceleratedPlan.fileSync.map(({ session }) => session),
                }
              : { status },
          ),
        ).pipe(provideFileSyncEngine(engine)),
      ),
    );
    // Then
    expect(result._tag).toBe("Failure");
  },
);

test("an availability probe error is not equivalent to reporting unavailable", async () => {
  // Given
  const failure = new FileSyncStartError({
    engineId: "mutagen",
    message: "Broken probe",
    remediation: "Repair engine",
  });
  // When
  const result = await Effect.runPromise(
    Effect.result(
      resolveFileSyncMountPlan(acceleratedPlan).pipe(
        provideFileSyncEngine({
          ...TestFileSyncEngine,
          id: "mutagen",
          isAvailable: Effect.fail(failure),
        }),
      ),
    ),
  );
  // Then
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") expect(result.failure.cause).toBe(failure);
});
