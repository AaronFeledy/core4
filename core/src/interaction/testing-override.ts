// Scenario/test-only seam letting an in-process CLI invocation resolve prompts
// through a supplied InteractionService (e.g. a seeded TestInteractionService)
// instead of the default stdio one. AsyncLocalStorage scopes the override to a
// single invocation so parallel scenario contexts never contaminate each other.
// Production CLI dispatch never sets an override, so the default path is unchanged.

import { AsyncLocalStorage } from "node:async_hooks";

import type { InteractionServiceShape } from "@lando/sdk/services";

const storage = new AsyncLocalStorage<InteractionServiceShape>();

/** The InteractionService override active for the current async context, if any. */
export const getInteractionServiceOverride = (): InteractionServiceShape | undefined => storage.getStore();

/** Run `thunk` with `service` installed as the active InteractionService override. */
export const withInteractionServiceOverride = <A>(
  service: InteractionServiceShape,
  thunk: () => Promise<A>,
): Promise<A> => storage.run(service, thunk);
