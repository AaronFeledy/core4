import { dirname } from "node:path";
import { AbsolutePath, AppPlan } from "@lando/sdk/schema";
import { StateStore } from "@lando/sdk/services";
import { Effect } from "effect";

export const openScratchPlan = Effect.fn("ScratchAppService.openPlan")(function* (planCache: AbsolutePath) {
  const store = yield* StateStore;
  return yield* store.open({
    root: { path: AbsolutePath.make(dirname(planCache)) },
    key: "plan.bin",
    schema: AppPlan,
    version: 1,
    codec: "binary",
    mode: 0o600,
    onCorrupt: "quarantine",
    onVersionMismatch: "discard",
  });
});
