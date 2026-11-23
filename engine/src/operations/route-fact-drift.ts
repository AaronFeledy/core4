import { MessageWarnEvent } from "@lando/sdk/events";
import type { AppPlan, CommandWarning } from "@lando/sdk/schema";
import { EventService } from "@lando/sdk/services";
import { DateTime, Effect, Option } from "effect";
import { commandWarningsUseMachineOutput, recordCommandWarningOnce } from "../landofile/command-warnings.ts";
import { boundRouteFacts, changedRouteFacts, recordedRouteFacts } from "../lifecycle/route-url-evidence.ts";
import type { RouteFacts } from "./connection-url.ts";

export const ROUTE_URL_DRIFT_CODE = "LANDO_ROUTE_URL_DRIFT";

/**
 * Services in the applied plan whose recorded environment holds a route fact for a target that no
 * longer matches what the target resolves to now, as happens when the router moves ports without
 * a restart. Each consumer is judged by the facts it binds, and one without recorded evidence is
 * left out: there is nothing to compare. Only targets resolved for this invocation are checked.
 */
export const routeFactDriftWarnings = (
  applied: AppPlan,
  current: Readonly<Record<string, RouteFacts>>,
): readonly CommandWarning[] =>
  Object.values(applied.services).flatMap((consumer) =>
    [...boundRouteFacts(consumer)].flatMap(([target, bound]) => {
      const now = Object.hasOwn(current, target) ? current[target] : undefined;
      const recorded = now === undefined ? undefined : recordedRouteFacts(consumer, target);
      if (now === undefined || recorded === undefined) return [];
      const changed = changedRouteFacts(bound, recorded, now);
      if (changed.length === 0) return [];
      const reads = changed.map((fact) => `services.${target}.${fact}`);
      return [
        {
          code: ROUTE_URL_DRIFT_CODE,
          message: `${consumer.name}'s recorded environment has ${changed
            .map((fact) => `${recorded[fact]} for services.${target}.${fact}`)
            .join(" and ")}, but it now resolves to ${changed.map((fact) => now[fact]).join(" and ")}.`,
          remediation: `Run \`lando start\` to give ${consumer.name} the current ${reads.join(" and ")}.`,
          context: {
            app: applied.id,
            consumer: consumer.name,
            target,
            recorded: recorded.url,
            current: now.url,
          },
        },
      ];
    }),
  );

/** Records each drift once per command for machine output and, for people, prints it once. */
export const publishRouteFactDrift = Effect.fnUntraced(function* (
  applied: AppPlan,
  current: Readonly<Record<string, RouteFacts>>,
) {
  const warnings = routeFactDriftWarnings(applied, current);
  if (warnings.length === 0) return;
  const machineOutput = yield* commandWarningsUseMachineOutput;
  const events = Option.getOrUndefined(yield* Effect.serviceOption(EventService));
  for (const warning of warnings) {
    const recorded = yield* recordCommandWarningOnce(warning);
    // A notice that cannot be printed must not fail the command it only advises; the warning is
    // already recorded for machine output.
    if (recorded && !machineOutput && events !== undefined)
      yield* events
        .publish(
          MessageWarnEvent.make({
            body: `${warning.message} ${warning.remediation}`,
            timestamp: yield* DateTime.now,
          }),
        )
        .pipe(Effect.catchTag("EventError", () => Effect.void));
  }
});
