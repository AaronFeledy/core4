import { expect, test } from "bun:test";
import { APPLIED_STATE_VERSION, migrateAppliedPlan } from "@lando/container-runtime/applied-state";
import type { PluginStateStore } from "@lando/sdk/plugins";
import { AppId } from "@lando/sdk/schema";
import { Effect } from "effect";
import { loadAppliedPlanStrict } from "../src/applied-state.ts";

test("docker wires v4 per-app state to the shared migration", async () => {
  const opens: Array<{
    readonly version: number;
    readonly key: string;
    readonly namespace?: string;
    readonly migrate: unknown;
  }> = [];
  const state: PluginStateStore = {
    open: (spec) => {
      opens.push({
        version: spec.version,
        key: spec.key,
        ...(spec.namespace === undefined ? {} : { namespace: spec.namespace }),
        migrate: spec.onVersionMismatch,
      });
      return Effect.die("recorded");
    },
    withLock: (_key, body) => body,
  };

  await Effect.runPromiseExit(loadAppliedPlanStrict(state, AppId.make("historical")));

  expect(opens).toEqual([
    {
      version: APPLIED_STATE_VERSION,
      namespace: "applied-plans",
      key: "historical.json",
      migrate: migrateAppliedPlan,
    },
  ]);
});
