import type { StartAppOptions } from "@lando/sdk/app";
import { Effect } from "effect";
import { type ResolvedAppTarget, resolveDesiredAppTarget } from "../landofile/app-resolution.ts";
import { startAppForTarget } from "./app-activation.ts";
import type { StartManagedScope } from "./start-file-sync.ts";

export type { CheckResult } from "@lando/sdk/schema";
export { startAppForTarget } from "./app-activation.ts";
export type { StartManagedScope } from "./start-file-sync.ts";
export type { StartAppError, StartAppOptions, StartAppResult } from "./start-internal.ts";

export const startApp = Effect.fn("AppOperation.start")(function* (
  options: StartAppOptions = {},
  target?: ResolvedAppTarget,
  managed?: StartManagedScope,
  execution: { readonly beforeStart?: Effect.Effect<void> } = {},
) {
  return yield* startAppForTarget(options, target ?? (yield* resolveDesiredAppTarget), managed, execution);
});
