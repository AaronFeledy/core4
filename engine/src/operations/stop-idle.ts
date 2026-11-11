import { MessageInfoEvent } from "@lando/sdk/events";
import type { AppPlan, EventStepPlan } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import type { ResolvedAppTarget } from "../landofile/app-resolution.ts";
import { mapFailureErrors } from "../lifecycle/failure-compensation.ts";
import { acceleratedStartStopError } from "./accelerated-start-disposal.ts";
import { cleanupAppWorkers } from "./destroy-provider.ts";
import { eventStepLabel } from "./event-step-identity.ts";
import type { StopAppPreflight } from "./stop-internal.ts";

export const idleStopEventPlan = Effect.fnUntraced(function* (
  plan: AppPlan,
  runInitEvents: boolean,
): Effect.fn.Return<AppPlan, never, EventService> {
  const events = yield* EventService;
  const filtered: Array<readonly [string, ReadonlyArray<EventStepPlan>]> = [];
  for (const [event, entries] of Object.entries(plan.events ?? {})) {
    if (
      event !== "pre-stop" &&
      event !== "post-stop" &&
      !(runInitEvents && (event === "pre-init" || event === "post-init"))
    ) {
      filtered.push([event, entries]);
      continue;
    }
    const runnable: EventStepPlan[] = [];
    for (const entry of entries) {
      const step = entry.step;
      if (
        entry.status !== "active" ||
        (typeof step !== "string" && "service" in step && step.service === ":host")
      ) {
        runnable.push(entry);
        continue;
      }
      yield* events
        .publish(
          MessageInfoEvent.make({
            body: `Skipped ${eventStepLabel(event, entry.source, entry.sourceIndex)}: runtime is idle.`,
            timestamp: DateTime.nowUnsafe(),
          }),
        )
        .pipe(Effect.ignore);
    }
    filtered.push([event, runnable]);
  }
  return { ...plan, events: Object.fromEntries(filtered) };
});

export const stopIdleApp = Effect.fnUntraced(function* (
  target: ResolvedAppTarget,
  preflight: StopAppPreflight,
) {
  // Route withdrawal belongs to the public stop and teardown callers; restart and rebuild retain routes.
  yield* cleanupAppWorkers(target.app);
  if (Option.isSome(preflight.maybeFileSync) && preflight.maybeFileSync.value.appLifecycle === undefined) {
    const engine = preflight.maybeFileSync.value;
    yield* Effect.forEach(preflight.sessions, (session) => engine.terminateSession(session.ref), {
      discard: true,
    }).pipe(mapFailureErrors((cause) => acceleratedStartStopError(target.app, cause)));
  }
  return { kind: "unchanged" as const };
});
