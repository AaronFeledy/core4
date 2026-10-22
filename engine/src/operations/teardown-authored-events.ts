import { MessageInfoEvent } from "@lando/sdk/events";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Predicate, Result } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { compiledEventsForPlan } from "../planner/effective-events.ts";
import { carryPlanAttachments } from "../planner/plan-attachments.ts";

export const withTeardownAuthoredEvents = Effect.fn("AppOperation.teardownAuthoredEvents")(function* <E, R>(
  applied: ResolvedAppTarget,
  desired: Effect.Effect<ResolvedAppTarget | undefined, E, R>,
) {
  if (compiledEventsForPlan(applied.plan) !== undefined) return applied;

  const events = yield* EventService;
  const skip = (reason: string) =>
    events
      .publish(
        MessageInfoEvent.make({
          body: `Skipping Landofile events for ${applied.app.id}: ${reason}.`,
          timestamp: DateTime.nowUnsafe(),
        }),
      )
      .pipe(Effect.ignore, Effect.as(applied));
  const resolved = yield* desired.pipe(Effect.result);
  if (Result.isFailure(resolved)) {
    const error = resolved.failure;
    const reason =
      Predicate.hasProperty(error, "_tag") && typeof error._tag === "string"
        ? error._tag
        : "desired plan unavailable";
    return yield* skip(reason);
  }
  const target = resolved.success;
  if (target === undefined) return yield* skip("desired plan unavailable");
  if (
    target.app.id !== applied.app.id ||
    target.root !== applied.root ||
    target.app.kind !== applied.app.kind
  )
    return yield* skip("desired app identity differs from applied state");

  carryPlanAttachments(target.plan, applied.plan);
  return applied;
});
