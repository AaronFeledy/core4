import type { AppPlan, PublicRouteFact, ServicePlan } from "@lando/sdk/schema";
import { Predicate } from "effect";
import type { RouteFacts } from "../operations/connection-url.ts";
import { routeUrlConsumers } from "../planner/route-url-validation.ts";
import type { PreparedRouteUrls } from "./route-url-bindings.ts";

const evidenceKey = "@lando/engine/realized-route-urls";

/** A route URL: scheme, a hostname with no port separator, an optional port, then the path. */
const RECORDED_URL = /^(https?):\/\/([^/:]+)(?::(\d+))?(\/.*)?$/u;

/**
 * The route facts a consumer was started with for a target, projected from the URL recorded as
 * evidence. Every other fact is a pure function of that URL, so the evidence stays URL-only;
 * the projection splits it by hand, never through `new URL()`, which rewrites or rejects hostnames
 * routes admit. Undefined when the consumer has no evidence for the target.
 */
export const recordedRouteFacts = (consumer: ServicePlan, target: string): RouteFacts | undefined => {
  const evidence = consumer.extensions[evidenceKey];
  if (!Predicate.isObject(evidence) || !Object.hasOwn(evidence, target)) return undefined;
  const url = evidence[target];
  const match = typeof url === "string" ? RECORDED_URL.exec(url) : null;
  if (match === null) return undefined;
  const [recordedUrl, scheme, hostname, port] = match;
  if (scheme === undefined || hostname === undefined) return undefined;
  return {
    url: recordedUrl,
    hostname,
    origin: `${scheme}://${hostname}${port === undefined ? "" : `:${port}`}`,
    publicPort: port ?? (scheme === "https" ? "443" : "80"),
    scheme,
  };
};

/** Each route target a consumer's environment reads, with the facts it binds. */
export const boundRouteFacts = (consumer: ServicePlan): ReadonlyMap<string, ReadonlySet<PublicRouteFact>> => {
  const bound = new Map<string, Set<PublicRouteFact>>();
  for (const { service, fact } of routeUrlConsumers({ services: { [consumer.name]: consumer } }))
    bound.set(service, new Set([...(bound.get(service) ?? []), fact]));
  return bound;
};

/** The bound facts whose recorded value differs from the current one; all of them when there is none. */
export const changedRouteFacts = (
  bound: ReadonlySet<PublicRouteFact>,
  recorded: RouteFacts,
  current: RouteFacts | undefined,
): readonly PublicRouteFact[] => [...bound].filter((fact) => recorded[fact] !== current?.[fact]);

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
