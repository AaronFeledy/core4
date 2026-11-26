import { RouteUrlBindingError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { PreparedRouteUrls } from "../lifecycle/route-url-bindings.ts";
import { boundRouteFacts, changedRouteFacts, recordedRouteFacts } from "../lifecycle/route-url-evidence.ts";

/** Each route target an applied consumer outside the selection reads, with the facts it binds. */
export const retainedRouteReferences = (applied: AppPlan | undefined, selected: AppPlan) =>
  applied === undefined
    ? []
    : Object.values(applied.services).flatMap((consumer) =>
        Object.hasOwn(selected.services, consumer.name)
          ? []
          : [...boundRouteFacts(consumer)].map(([service, facts]) => ({ consumer, service, facts })),
      );

/**
 * Refuse a selected activation that would change a route fact a retained consumer's environment
 * holds. Each consumer is judged by the facts it binds: a hostname reader survives a port move and
 * an origin reader survives a path-only edit. A consumer with no recorded evidence is refused.
 */
export const refuseRetainedRouteConsumers = Effect.fn("Activation.refuseRetainedRouteConsumers")(
  function* (input: {
    readonly retained: ReturnType<typeof retainedRouteReferences>;
    readonly runtimePlan: AppPlan;
    readonly proof: PreparedRouteUrls | undefined;
    readonly operation: "start" | "restart" | "rebuild";
  }) {
    const affected = new Set<string>();
    const reasons: string[] = [];
    let target: string | undefined;
    for (const { consumer, service, facts } of input.retained) {
      const previous = recordedRouteFacts(consumer, service);
      const next = input.proof?.facts.get(service);
      const found =
        previous === undefined
          ? [`Lando has no record of the route ${consumer.name} was started with for services.${service}.`]
          : changedRouteFacts(facts, previous, next).map(
              (fact) =>
                `${consumer.name} uses ${previous[fact]} for services.${service}.${fact}, but this ${input.operation} publishes ${next?.[fact] ?? "no value"}.`,
            );
      if (found.length === 0) continue;
      target ??= service;
      affected.add(consumer.name);
      reasons.push(...found);
    }
    if (target !== undefined) {
      const consumers = [...affected];
      const flags = [...Object.keys(input.runtimePlan.services), ...consumers]
        .map((name) => `--service ${name}`)
        .join(" ");
      return yield* new RouteUrlBindingError({
        reason: "retained-consumer",
        service: target,
        consumers,
        message: reasons.join(" "),
        remediation: `Run \`lando ${input.operation} ${flags}\` to include those services, or run \`lando start\`.`,
      });
    }
  },
);
