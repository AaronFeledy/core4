import { expect, test } from "bun:test";
import { Cause, Effect, Option } from "effect";

import { FileSyncStartError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, PortablePath } from "@lando/sdk/schema";

import { beginAcceleratedStart } from "../../src/operations/accelerated-start-journal.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test.each(["preparing", "sessions-ready", "apply-intent"] as const)(
  "retention keeps original failures first when the journal write fails from %s",
  async (phase) => {
    // Given a pending attempt whose durable journal becomes unreadable before retention.
    const app = { kind: "user", id: plan.id, root: plan.root } as const;
    const acceleratedPlan: AppPlan = {
      ...plan,
      fileSync: [
        {
          engineId: "mutagen",
          session: {
            app,
            service: web.name,
            mountKey: "app-mount",
            source: plan.root,
            target: { _tag: "volume", name: "test-sync", path: PortablePath.make("/app") },
            mode: "two-way-safe",
            excludes: [],
          },
        },
      ],
    };
    const store = makeTestStateStore();
    const pending = await Effect.runPromise(
      beginAcceleratedStart(acceleratedPlan, app).pipe(Effect.provide(store.layer)),
    );
    if (phase !== "preparing") await Effect.runPromise(pending.phase("sessions-ready"));
    if (phase === "apply-intent") await Effect.runPromise(pending.phase("apply-intent"));
    const path = Array.from(store.snapshot().keys())[0];
    if (path === undefined) throw new Error("Expected journal path");
    await Effect.runPromise(store.writeRaw(AbsolutePath.make(path), "invalid journal"));
    const original = new ProviderUnavailableError({
      providerId: "lando",
      operation: "apply",
      message: "apply failed",
    });
    const secondary = new FileSyncStartError({ engineId: "mutagen", message: "secondary failure" });

    // When retention cannot persist its phase.
    const cause = await Effect.runPromise(
      pending.retainTargets(Cause.combine(Cause.fail(original), Cause.fail(secondary))),
    );

    // Then the original failure stays first, followed by the secondary and journal failures.
    expect(Option.getOrThrow(Cause.findErrorOption(cause))).toBe(original);
    const failures = Array.from(cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error));
    expect(failures).toHaveLength(3);
    expect(failures[0]).toBe(original);
    expect(failures[1]).toBe(secondary);
    const journalFailure = failures[2];
    expect(journalFailure).toBeInstanceOf(FileSyncStartError);
    if (!(journalFailure instanceof FileSyncStartError)) throw new Error("Expected journal failure");
    expect(journalFailure.cause).toMatchObject({ _tag: "StateStoreError", reason: "decode" });
    expect(journalFailure.remediation).toContain(path);
  },
);
