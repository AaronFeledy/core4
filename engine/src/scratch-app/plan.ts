import { dirname } from "node:path";
import { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";

/** Desired-plan cache frame; bumps discard incompatible executable scratch plans. */
export const SCRATCH_DESIRED_PLAN_VERSION = 3;
export const ScratchDesiredPlan = AppPlan;

export const openScratchPlan = Effect.fn("ScratchAppService.openPlan")(function* (planCache: AbsolutePath) {
  const store = yield* StateStore;
  return yield* store.open({
    root: { path: AbsolutePath.make(dirname(planCache)) },
    key: "plan.bin",
    schema: ScratchDesiredPlan,
    version: SCRATCH_DESIRED_PLAN_VERSION,
    codec: "binary",
    mode: 0o600,
    onCorrupt: "quarantine",
    onVersionMismatch: "discard",
    onNewerVersion: "discard",
  });
});
