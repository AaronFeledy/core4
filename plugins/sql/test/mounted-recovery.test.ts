import { afterEach, expect, it } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { executeDbCommand } from "../src/execute.ts";
import { cleanupSqlTestDeps, makeSqlTestDeps } from "./support/fakes.ts";

afterEach(cleanupSqlTestDeps);

it("refuses restore when the mounted generation changes during backup", async () => {
  const harness = makeSqlTestDeps({ password: "test" });
  let replaced = false;
  const deps = {
    ...harness.deps,
    snapshot: (...args: Parameters<typeof harness.deps.snapshot>) =>
      harness.deps.snapshot(...args).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            replaced = true;
          }),
        ),
      ),
    inspectVolume: (service: string, store: string) =>
      harness.deps.inspectVolume(service, store).pipe(
        Effect.map((volume) =>
          !replaced || !volume?.identity
            ? volume
            : {
                ...volume,
                identity: { ...volume.identity, generation: "replaced-generation" },
              },
        ),
      ),
  };
  const result = await Effect.runPromise(
    Effect.either(executeDbCommand(deps, { action: "restore", snapshotId: "source", yes: true })),
  );
  expect(result._tag).toBe("Left");
  expect(harness.lifecycle()).toEqual(["lock", "suspend", "snapshot"]);
});

it("snapshots the mounted native volume when it differs from the plan", async () => {
  const harness = makeSqlTestDeps({ password: "test" });
  const deps = {
    ...harness.deps,
    inspectVolume: (service: string, store: string) =>
      harness.deps.inspectVolume(service, store).pipe(
        Effect.map((volume) =>
          volume === undefined
            ? undefined
            : {
                ...volume,
                ref: { app: AppId.make("sql-app"), store: "actual-data" },
                ...(volume.identity === undefined
                  ? {}
                  : { identity: { ...volume.identity, nativeName: "actual-data" } }),
              },
        ),
      ),
  };
  await Effect.runPromise(executeDbCommand(deps, { action: "snapshot", yes: false }));
  expect(harness.snapshots().map((snapshot) => snapshot.store)).toEqual(["actual-data"]);
});
