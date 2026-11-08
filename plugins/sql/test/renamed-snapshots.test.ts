import { afterEach, expect, test } from "bun:test";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { executeDbCommand } from "../src/run.ts";
import { cleanupSqlTestDeps } from "./support/fakes.ts";
import { makeRetentionTestDeps } from "./support/retention-store.ts";
import { sourcePlan } from "./support/source-plan.ts";

afterEach(cleanupSqlTestDeps);

test.each([undefined, "renamed", "sibling"])(
  "lists and restores original snapshots after rename with fromApp=%s",
  async (fromApp) => {
    const fixture = await makeRetentionTestDeps();
    const original = {
      ...fixture.deps,
      plan: {
        ...fixture.deps.plan,
        identity: {
          ...fixture.deps.plan.identity,
          repoGroupKey: "repository:sql-app",
        },
      },
    };
    const snapshot = await Effect.runPromise(executeDbCommand(original, { action: "snapshot", yes: true }));
    if (snapshot.snapshotId === undefined) throw new Error("Expected captured snapshot");
    const deps = {
      ...fixture.deps,
      appliedPlans: Effect.succeed([
        {
          ...sourcePlan(fixture.harness.root),
          id: AppId.make("sibling"),
          identity: {
            ...fixture.deps.plan.identity,
            dataName: "sql-app",
            repoGroupKey: "repository:sql-app",
          },
        },
      ]),
      plan: {
        ...fixture.deps.plan,
        id: "renamed",
        name: "renamed",
        identity: { ...fixture.deps.plan.identity, dataName: "sql-app", repoGroupKey: "repository:sql-app" },
      },
    };
    const selected = { ...(fromApp === undefined ? {} : { fromApp }), yes: true };
    const listed = await Effect.runPromise(executeDbCommand(deps, { ...selected, action: "snapshots" }));
    expect(listed.snapshots?.map((info) => info.id)).toEqual([snapshot.snapshotId]);
    expect(listed.snapshots?.map((info) => info.store.app)).toEqual([AppId.make("sql-app")]);
    await Effect.runPromise(
      executeDbCommand(deps, { ...selected, action: "restore", snapshotId: snapshot.snapshotId }),
    );
    expect(fixture.harness.restores().map((restore) => ({ id: restore.id, app: restore.store.app }))).toEqual(
      [{ id: snapshot.snapshotId, app: AppId.make("sql-app") }],
    );
  },
);
