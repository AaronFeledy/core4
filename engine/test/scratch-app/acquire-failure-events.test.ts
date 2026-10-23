import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { ScratchAppService } from "@lando/sdk/services";
import { Effect } from "effect";
import { withDestroyFixture } from "./destroy-fixture.ts";

test("fork copy failure keeps the instance until the bracket's standard destroy pair completes", async () => {
  // Given a full fork whose root transfer fails.
  await withDestroyFixture({ orphan: true, copyFail: true }, async (f) => {
    // When acquisition rolls back.
    await expect(
      Effect.runPromise(
        Effect.flatMap(ScratchAppService, (s) =>
          s.acquire({ source: { kind: "fork" }, isolate: "full", detached: false }),
        ).pipe(Effect.scoped, Effect.provide(f.layer)),
      ),
    ).rejects.toThrow("Unable to copy the source app root");
    // Then filesystem cleanup happens after the standard stop/destroy events.
    expect(f.rootObservations).toEqual([
      { tag: "pre-scratch-destroy", exists: true },
      { tag: "pre-stop", exists: true },
      { tag: "post-stop", exists: true },
      { tag: "pre-destroy", exists: true },
      { tag: "post-destroy", exists: true },
      { tag: "post-scratch-destroy", exists: false },
    ]);
    for (const _tag of ["pre-scratch-destroy", "post-scratch-destroy"])
      expect(f.events.find((event) => event._tag === _tag)).toMatchObject({ reason: "acquire-failure" });
    expect(f.entries.size).toBe(0);
  });
});

test("fork copy failure retains the instance without a destroy bracket when keep-on-failure is set", async () => {
  // Given a full fork with retention enabled and a failing root transfer.
  await withDestroyFixture({ orphan: true, copyFail: true }, async (f) => {
    // When acquisition fails.
    await expect(
      Effect.runPromise(
        Effect.flatMap(ScratchAppService, (s) =>
          s.acquire({ source: { kind: "fork" }, isolate: "full", detached: false, keepOnFailure: true }),
        ).pipe(Effect.scoped, Effect.provide(f.layer)),
      ),
    ).rejects.toThrow("Unable to copy the source app root");
    // Then no teardown occurs and the registered instance remains available.
    expect(f.events).toEqual([]);
    expect(f.entries.size).toBe(1);
    for (const entry of f.entries.values()) expect(existsSync(entry.rootPath)).toBe(true);
  });
});
