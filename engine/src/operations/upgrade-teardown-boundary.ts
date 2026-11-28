import type { AppId } from "@lando/sdk/schema";
import { Context, Effect } from "effect";

export const UpgradeTeardown = Context.Reference<Set<AppId> | undefined>("@lando/engine/UpgradeTeardown", {
  defaultValue: () => undefined,
});

/** Fence off restart before an irreversible step that can fail after committing. */
export const markUpgradeTeardown = (app: AppId): Effect.Effect<void> =>
  Effect.map(UpgradeTeardown, (started) => {
    started?.add(app);
  });
