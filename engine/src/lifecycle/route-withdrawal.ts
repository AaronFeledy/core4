import type { ProxyApplyError, ProxyError } from "@lando/sdk/errors";
import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppRouteOwner, RoutePlan } from "@lando/sdk/schema";
import { EventService, RouterService } from "@lando/sdk/services";
import type { TaskTreeController } from "@lando/sdk/task-progress";
import { DateTime, Effect, Option, Result } from "effect";

import { unavailableRouterReason } from "../subsystems/proxy/api.ts";

/** Whether teardown actually withdrew an owner's routes; only `withdrawn` proves cleanup. */
export type RouteWithdrawal =
  | { readonly kind: "withdrawn" }
  | { readonly kind: "skipped"; readonly reason: string };

/**
 * Teardown withdraws routes through the selected router, and a failure there is fatal. With no
 * selectable router, teardown withdraws through every installed router instead; when none is
 * installed or any of them fails, teardown warns with that cause and continues without proof of
 * cleanup.
 */
export const withdrawOwnerRoutes = Effect.fn("Lifecycle.withdrawOwnerRoutes")(function* (
  owner: AppRouteOwner,
): Effect.fn.Return<RouteWithdrawal, ProxyError, EventService> {
  const router = yield* Effect.serviceOption(RouterService);
  const unavailable = Option.isSome(router) ? unavailableRouterReason(router.value) : undefined;
  let failure: ProxyError | undefined;
  if (Option.isSome(router)) {
    if (unavailable === undefined) {
      yield* router.value.removeRoutes(owner);
      return { kind: "withdrawn" };
    }
    const delegated = yield* Effect.result(router.value.removeRoutes(owner));
    if (Result.isSuccess(delegated)) return { kind: "withdrawn" };
    failure = delegated.failure;
  }
  // The unavailable router fails with its own reason when no router is installed; any other
  // failure came from an installed router and is the cause the user has to act on.
  const installedFailed = failure !== undefined && failure !== unavailable;
  const reason =
    failure === undefined
      ? "No router service is available in this runtime."
      : `${failure.message} ${failure.remediation}`;
  const events = yield* EventService;
  yield* events
    .publish(
      MessageWarnEvent.make({
        body: `Routes for ${owner.id} were not withdrawn because ${
          installedFailed ? "an installed router could not remove them" : "no router is available"
        }. ${reason}`,
        timestamp: DateTime.nowUnsafe(),
      }),
    )
    .pipe(Effect.ignore);
  return { kind: "skipped", reason };
});

export const settleRoutesTask = (
  tree: TaskTreeController,
  withdrawal: RouteWithdrawal,
): Effect.Effect<void> => {
  switch (withdrawal.kind) {
    case "withdrawn":
      return tree.completeTask("routes");
    case "skipped":
      return tree.warnTask("routes", "Routes not withdrawn");
    default:
      return withdrawal satisfies never;
  }
};

/**
 * Selected teardown republishes the owner's surviving routes. With no selectable router there is
 * nothing to republish through, so stopping warns and continues; an installed router's failure stays fatal.
 */
export const republishRetainedRoutes = Effect.fn("Lifecycle.republishRetainedRoutes")(function* (
  routes: ReadonlyArray<RoutePlan>,
  owner: AppRouteOwner,
  stopped: ReadonlyArray<string>,
): Effect.fn.Return<void, ProxyApplyError, RouterService | EventService> {
  const router = yield* RouterService;
  const unavailable = unavailableRouterReason(router);
  if (unavailable === undefined) {
    yield* router.applyRoutes(routes, owner);
    return;
  }
  const events = yield* EventService;
  yield* events
    .publish(
      MessageWarnEvent.make({
        body: `Routes for ${owner.id} were not updated after stopping ${stopped.join(", ")} because no router is available. ${unavailable.message} ${unavailable.remediation}`,
        timestamp: DateTime.nowUnsafe(),
      }),
    )
    .pipe(Effect.ignore);
});
