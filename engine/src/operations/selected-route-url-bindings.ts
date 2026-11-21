import { RouteUrlBindingError } from "@lando/sdk/errors";
import type { AppPlan } from "@lando/sdk/schema";
import { Effect } from "effect";
import type { PreparedRouteUrls } from "../lifecycle/route-url-bindings.ts";
import { recordedRouteUrl } from "../lifecycle/route-url-evidence.ts";
import { routeUrlConsumers } from "../planner/route-url-validation.ts";

export const retainedRouteReferences = (applied: AppPlan | undefined, selected: AppPlan) =>
  applied === undefined
    ? []
    : Object.values(applied.services).flatMap((consumer) =>
        Object.hasOwn(selected.services, consumer.name)
          ? []
          : routeUrlConsumers({ services: { [consumer.name]: consumer } }).map(({ service }) => ({
              consumer,
              service,
            })),
      );

export const refuseRetainedRouteConsumers = Effect.fn("Activation.refuseRetainedRouteConsumers")(
  function* (input: {
    readonly retained: ReturnType<typeof retainedRouteReferences>;
    readonly runtimePlan: AppPlan;
    readonly proof: PreparedRouteUrls | undefined;
    readonly operation: "restart" | "rebuild";
  }) {
    const affected = new Set<string>();
    const reasons: string[] = [];
    let target: string | undefined;
    for (const { consumer, service } of input.retained) {
      const previous = recordedRouteUrl(consumer, service);
      const next = input.proof?.urls.get(service);
      if (previous !== undefined && previous === next) continue;
      target ??= service;
      affected.add(consumer.name);
      reasons.push(
        previous === undefined
          ? `Lando has no record of the URL ${consumer.name} was started with for services.${service}.url.`
          : `${consumer.name} uses ${previous} for services.${service}.url, but this ${input.operation} publishes ${next ?? "no URL"}.`,
      );
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
