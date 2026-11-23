import type { AppPlan, ServicePlan } from "@lando/sdk/schema";
import { Predicate } from "effect";
import { routeUrlConsumers } from "../planner/route-url-validation.ts";
import type { PreparedRouteUrls } from "./route-url-bindings.ts";

const evidenceKey = "@lando/engine/realized-route-urls";

export const recordedRouteUrl = (consumer: ServicePlan, target: string): string | undefined => {
  const evidence = consumer.extensions[evidenceKey];
  if (!Predicate.isObject(evidence) || !Object.hasOwn(evidence, target)) return undefined;
  const url = evidence[target];
  return typeof url === "string" ? url : undefined;
};

export const recordRouteUrlEvidence = (
  record: AppPlan,
  activated: AppPlan,
  proof: PreparedRouteUrls | undefined,
): AppPlan => {
  if (proof === undefined) return record;
  const byConsumer = new Map<string, Map<string, string>>();
  for (const { consumer, service } of routeUrlConsumers(activated)) {
    const url = proof.facts.get(service)?.url;
    if (url === undefined) continue;
    const evidence = byConsumer.get(consumer) ?? new Map<string, string>();
    evidence.set(service, url);
    byConsumer.set(consumer, evidence);
  }
  if (byConsumer.size === 0) return record;
  return {
    ...record,
    services: Object.fromEntries(
      Object.entries(record.services).map(([name, consumer]) => {
        const evidence = byConsumer.get(name);
        return [
          name,
          evidence === undefined
            ? consumer
            : {
                ...consumer,
                extensions: { ...consumer.extensions, [evidenceKey]: Object.fromEntries(evidence) },
              },
        ];
      }),
    ),
  };
};
