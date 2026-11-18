import { expect, test } from "bun:test";
import { APPLIED_STATE_VERSION } from "@lando/container-runtime/applied-state";
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

  expect(opens).toHaveLength(1);
  expect(opens[0]).toMatchObject({
    version: APPLIED_STATE_VERSION,
    namespace: "applied-plans",
    key: "historical.json",
  });
  // Unconvertible historical payloads throw.
  expect(typeof opens[0]?.migrate).toBe("function");
  const migrate = opens[0]?.migrate as (raw: unknown, version: number) => unknown;
  expect(() => migrate({ not: "a plan" }, 1)).toThrow(
    `Cannot read applied state v1 as v${APPLIED_STATE_VERSION}`,
  );
});
