import { isDeepStrictEqual } from "node:util";

import type { AppId, RoutePlan } from "@lando/sdk/schema";
import { Option, Schema } from "effect";

import { routeBackendUrl, routeMiddlewareConfig } from "./route-provider-config.ts";
import { routeRule } from "./routing.ts";

// Traefik v3.3 pkg/api/handler.go and pkg/config/runtime/runtime_http.go.
// Decode only the HTTP graph. Never retain or report raw configuration/errors.
const RawData = Schema.Struct({
  routers: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  services: Schema.Record(Schema.String, Schema.Record(Schema.String, Schema.Unknown)),
  middlewares: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
});
const RuntimeStatus = {
  status: Schema.String,
  error: Schema.optionalKey(Schema.Array(Schema.String)),
};
const Router = Schema.Struct({
  ...RuntimeStatus,
  rule: Schema.String,
  service: Schema.String,
  priority: Schema.Number,
  entryPoints: Schema.Array(Schema.String),
  using: Schema.Array(Schema.String),
  tls: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  middlewares: Schema.optionalKey(Schema.Array(Schema.String)),
});
const Service = Schema.Struct({
  ...RuntimeStatus,
  loadBalancer: Schema.Struct({ servers: Schema.Array(Schema.Struct({ url: Schema.String })) }),
});
const Middleware = Schema.Record(Schema.String, Schema.Unknown);

export const decodeRouteSnapshot = Schema.decodeUnknownOption(Schema.fromJsonString(RawData));
export type RouteSnapshot = typeof RawData.Type;

// Normalize only documented provider defaults, never arbitrary extra behavior.
const effectiveMiddleware = (config: Readonly<Record<string, unknown>>) => {
  const strip = Schema.decodeUnknownOption(
    Schema.Struct({
      prefixes: Schema.Array(Schema.String),
      forceSlash: Schema.optionalKey(Schema.Boolean),
    }),
    { onExcessProperty: "error" },
  )(config.stripPrefix);
  if (Option.isSome(strip)) return { ...config, stripPrefix: { forceSlash: true, ...strip.value } };
  const redirect = Schema.decodeUnknownOption(
    Schema.Struct({
      regex: Schema.String,
      replacement: Schema.String,
      permanent: Schema.optionalKey(Schema.Boolean),
    }),
    { onExcessProperty: "error" },
  )(config.redirectRegex);
  if (Option.isSome(redirect)) return { ...config, redirectRegex: { permanent: false, ...redirect.value } };
  return config;
};

const reference = (name: string): string => (name.endsWith("@file") ? name : `${name}@file`);

export const matchesLiveRoute = (
  snapshot: RouteSnapshot,
  app: AppId,
  requested: { readonly route: RoutePlan; readonly scheme: "http" | "https" },
): boolean | undefined => {
  const { route, scheme } = requested;
  const namespace = `route-${encodeURIComponent(String(app))}-`;
  const matches = Object.entries(snapshot.routers).map(([name, rawRouter]) => {
    if (!name.startsWith(namespace) || !name.endsWith(`-${scheme}@file`)) return false;
    const index = name.slice(namespace.length, -`-${scheme}@file`.length);
    if (!/^\d+$/.test(index)) return false;
    const router = Option.getOrUndefined(Schema.decodeUnknownOption(Router)(rawRouter));
    if (router === undefined) return undefined;
    const serviceName = `${namespace}${index}`;
    const entryPoint = scheme === "https" ? "websecure" : "web";
    if (
      router.status !== "enabled" ||
      (router.error?.length ?? 0) !== 0 ||
      router.rule !== routeRule(route) ||
      router.priority !== route.priority ||
      reference(router.service) !== `${serviceName}@file` ||
      !isDeepStrictEqual(router.entryPoints, [entryPoint]) ||
      !isDeepStrictEqual(router.using, [entryPoint]) ||
      (scheme === "https") !== (router.tls !== undefined && router.tls !== null)
    )
      return false;
    const service = Option.getOrUndefined(
      Schema.decodeUnknownOption(Service)(snapshot.services?.[`${serviceName}@file`]),
    );
    if (service === undefined) return undefined;
    const backend = routeBackendUrl(route, app);
    if (
      service.status !== "enabled" ||
      (service.error?.length ?? 0) !== 0 ||
      !isDeepStrictEqual(service.loadBalancer.servers, [{ url: backend }])
    )
      return false;
    const filters = route.filters ?? [];
    const middlewareNames = filters.map(
      (filter, filterIndex) => `${serviceName}-f${filterIndex}-${filter.type}@file`,
    );
    if (!isDeepStrictEqual((router.middlewares ?? []).map(reference), middlewareNames)) return false;
    return filters.every((filter, filterIndex) => {
      const middlewareName = middlewareNames[filterIndex];
      if (middlewareName === undefined) return false;
      const decoded = Option.getOrUndefined(
        Schema.decodeUnknownOption(Middleware)(snapshot.middlewares?.[middlewareName]),
      );
      if (decoded === undefined) return false;
      const { status, error, usedBy: _usedBy, ...config } = decoded;
      return (
        status === "enabled" &&
        (error === undefined || isDeepStrictEqual(error, [])) &&
        isDeepStrictEqual(effectiveMiddleware(config), effectiveMiddleware(routeMiddlewareConfig(filter)))
      );
    });
  });
  return matches.includes(true) ? true : matches.includes(undefined) ? undefined : false;
};
