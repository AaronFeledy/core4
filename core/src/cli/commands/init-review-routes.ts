import { mergeRouterConfig } from "@lando/engine/config/router-config";
import { connectionUrl } from "@lando/engine/operations/connection-url";
import { normalizeRoute } from "@lando/landofile/route-normalize";
import { isPlainRecord } from "@lando/sdk/landofile";
import { EndpointPlan, RouteInput, RouterConfig, selectHttpEndpoint } from "@lando/sdk/schema";
import { Result, Schema } from "effect";
import type { RecipeInitReview } from "../../recipes/prepared-init";
import { INIT_REVIEW_LIMIT, type InitReviewConfig, reviewSites } from "./init-review-sites";

export interface InitReviewRoutes {
  readonly status: "candidate" | "none" | "unresolved" | "disabled" | "unavailable";
  readonly candidates: readonly { readonly service: string; readonly url: string }[];
  readonly services: readonly { readonly name: string; readonly type?: string }[];
  readonly unresolved: number;
  readonly truncated: boolean;
}

/** Authored URL intent only: no catalog, planner, provider, or live route observation. */
export const projectInitReviewRoutes = (
  review: RecipeInitReview,
  config: InitReviewConfig | undefined,
): InitReviewRoutes => {
  const site = reviewSites(review, config);
  const source = site.value(review.source);
  if (!isPlainRecord(source))
    return {
      status: config === undefined ? "unavailable" : "unresolved",
      candidates: [],
      services: [],
      unresolved: 1,
      truncated: false,
    };
  const serviceMap = site.value(source.services);
  const proxyMap = site.value(source.proxy);
  const services: { readonly name: string; readonly type?: string }[] = [];
  const candidates: { readonly service: string; readonly url: string }[] = [];
  let unresolved = serviceMap === undefined || isPlainRecord(serviceMap) ? 0 : 1;
  if (proxyMap !== undefined && !isPlainRecord(proxyMap)) unresolved++;
  let truncated = false;
  const base = () => ({ services, candidates, unresolved, truncated });
  const entries = isPlainRecord(serviceMap) ? Object.entries(serviceMap) : [];
  for (const [name, input] of entries.slice(0, INIT_REVIEW_LIMIT)) {
    const service = site.value(input);
    const type = isPlainRecord(service) ? site.value(service.type) : undefined;
    services.push({ name, ...(typeof type === "string" ? { type } : {}) });
  }
  truncated = entries.length > INIT_REVIEW_LIMIT;
  if (config === undefined) return { ...base(), status: "unavailable" };
  const router =
    source.router === undefined
      ? Result.succeed(undefined)
      : Schema.decodeUnknownResult(RouterConfig)(
          site.fields(source.router, ["enabled", "httpPort", "httpsPort", "httpFallbacks", "httpsFallbacks"]),
        );
  if (Result.isFailure(router)) return { ...base(), status: "unresolved", unresolved: unresolved + 1 };
  const ingress = mergeRouterConfig(config.router, router.success);
  if (!ingress.enabled) return { ...base(), status: "disabled" };
  let routeCount = 0;
  const seen = new Set<string>();
  for (const [name, input] of entries.slice(0, INIT_REVIEW_LIMIT)) {
    const service = site.value(input);
    if (!isPlainRecord(service)) {
      unresolved++;
      continue;
    }
    const endpointInput = site.value(service.endpoints);
    const endpoints: EndpointPlan[] = [];
    let endpointsResolved = endpointInput === undefined || Array.isArray(endpointInput);
    if (Array.isArray(endpointInput)) {
      if (endpointInput.length > INIT_REVIEW_LIMIT) {
        truncated = true;
        endpointsResolved = false;
      }
      for (const endpoint of endpointInput.slice(0, INIT_REVIEW_LIMIT)) {
        const fields = site.fields(endpoint, ["protocol", "port", "name", "primary"]);
        // Publication is unrelated to the route's logical backend listener.
        const decoded = Schema.decodeUnknownResult(EndpointPlan)(
          isPlainRecord(fields) ? { ...fields, _tag: "internal" } : fields,
        );
        if (Result.isSuccess(decoded)) endpoints.push(decoded.success);
        else endpointsResolved = false;
      }
    }
    const routeGroups = [service.routes, isPlainRecord(proxyMap) ? proxyMap[name] : undefined];
    for (const group of routeGroups) {
      if (group === undefined) continue;
      const routes = site.value(group);
      if (!Array.isArray(routes)) {
        unresolved++;
        continue;
      }
      for (const authored of routes) {
        if (++routeCount > INIT_REVIEW_LIMIT) {
          truncated = true;
          break;
        }
        const route = Schema.decodeUnknownResult(RouteInput)(
          site.fields(authored, ["hostname", "scheme", "endpoint", "pathPrefix"]),
        );
        if (Result.isFailure(route)) {
          unresolved++;
          continue;
        }
        const normalized = normalizeRoute(route.success, { path: ["services", name, "routes"] });
        if (Result.isFailure(normalized)) {
          unresolved++;
          continue;
        }
        const value = normalized.success;
        // No explicit endpoints means type-provided listeners are unknown, not guessed.
        // A route with no selector still states a configured hostname candidate.
        if (
          !endpointsResolved ||
          ((endpointInput !== undefined || value.endpoint !== undefined) &&
            selectHttpEndpoint(endpoints, value.endpoint).status !== "selected") ||
          value.hostname.includes("*")
        ) {
          unresolved++;
          continue;
        }
        const schemes = value.scheme === "both" ? (["http", "https"] as const) : [value.scheme ?? "https"];
        for (const protocol of schemes) {
          const url = connectionUrl({
            host: value.hostname,
            protocol,
            port: protocol === "http" ? ingress.httpPorts[0] : ingress.httpsPorts[0],
            ...(value.pathPrefix === undefined ? {} : { pathPrefix: value.pathPrefix }),
          });
          if (seen.has(url)) continue;
          seen.add(url);
          candidates.push({ service: name, url });
        }
      }
    }
  }
  if (isPlainRecord(proxyMap)) {
    for (const name of Object.keys(proxyMap))
      if (!isPlainRecord(serviceMap) || !Object.hasOwn(serviceMap, name)) unresolved++;
  }
  return {
    ...base(),
    status: candidates.length > 0 ? "candidate" : unresolved > 0 || truncated ? "unresolved" : "none",
  };
};
