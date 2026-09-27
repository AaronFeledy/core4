import { expect, test } from "bun:test";
import { Cause, Effect, Option } from "effect";

import { FileSyncStartError, ProviderUnavailableError } from "@lando/sdk/errors";
import { AbsolutePath, type AppPlan, PortablePath } from "@lando/sdk/schema";

import { beginAcceleratedStart } from "../../src/operations/accelerated-start-journal.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";
import { plan, web } from "./start-progress-topology-support.ts";

test.each(["preparing", "sessions-ready", "apply-intent"] as const)(
  "retention preserves original failures when the journal write fails from %s",
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
      pending.retainTargets(Cause.parallel(Cause.fail(original), Cause.fail(secondary))),
    );

    // Then recovery stays first, followed by every original failure and the journal failure.
    const retained = Option.getOrThrow(Cause.failureOption(cause));
    expect(retained).toMatchObject({
      _tag: "FileSyncStartError",
      cause: original,
      message: expect.stringContaining(original.message),
      remediation: expect.stringContaining(path),
    });
    expect(Array.from(Cause.failures(cause))).toEqual([
      retained,
      original,
      secondary,
      expect.objectContaining({
        _tag: "FileSyncStartError",
        cause: expect.objectContaining({ _tag: "StateStoreError", reason: "decode" }),
      }),
    ]);
  },
);
