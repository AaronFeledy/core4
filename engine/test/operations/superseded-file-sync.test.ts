import { expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { AppId } from "@lando/sdk/schema";
import { FileSyncEngine } from "@lando/sdk/services";
import { TestFileSyncEngine } from "@lando/sdk/test";
import { Effect } from "effect";
import { appLockTarget, withAppMutationLock } from "../../src/operations/app-mutation-lock.ts";
import { retireSupersededRealizations } from "../../src/operations/superseded-realizations.ts";
import { selectPreparedProvider } from "../../src/providers/prepared.ts";
import { oldPlan, ordinaryPlan, rotationHarness } from "./start-file-sync-rotation-support.ts";

test.each([false, true])(
  "rename uses the recorded sync engine and preserves history on drain failure: %s",
  async (failDrain) => {
    const desired = { ...ordinaryPlan, id: AppId.make("renamed"), name: "renamed", slug: "renamed" };
    const harness = await Effect.runPromise(
      rotationHarness({ desired, ...(failDrain ? { failAt: "conflict" as const } : {}) }),
    );
    try {
      const target = {
        plan: desired,
        root: desired.root,
        app: { kind: "user" as const, id: desired.id, root: desired.root },
      };
      const result = await Effect.runPromise(
        withAppMutationLock(
          appLockTarget(desired),
          Effect.gen(function* () {
            const provider = yield* selectPreparedProvider(desired);
            yield* retireSupersededRealizations(target, [oldPlan], { provider });
          }),
        ).pipe(
          Effect.provideService(FileSyncEngine, {
            ...TestFileSyncEngine,
            id: "unrelated-desired-engine",
            listSessions: () => Effect.die("must use the recorded engine"),
          }),
          Effect.provide(harness.layer),
          Effect.result,
        ),
      );
      expect(result._tag).toBe(failDrain ? "Failure" : "Success");
      expect(harness.sessions.map(({ spec }) => spec)).toEqual(
        failDrain ? oldPlan.fileSync.map(({ session }) => session) : [],
      );
      expect(harness.applied()).toEqual(failDrain ? oldPlan : undefined);
      expect(harness.cleanedPlans).toEqual(failDrain ? [] : [oldPlan]);
      expect(harness.events.filter((event) => event._tag === "message.warn")).toHaveLength(failDrain ? 0 : 1);
    } finally {
      rmSync(harness.userDataRoot, { recursive: true, force: true });
    }
  },
);
