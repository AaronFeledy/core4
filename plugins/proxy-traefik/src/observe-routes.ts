import { RequestPolicy } from "@lando/http-client";
import { type AppId, PortNumber, type RouteEvidence, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";

import { readAcquisitionState } from "./port-acquisition-state.ts";
import { defaultDomainFile } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { decodeRouteSnapshot, matchesLiveRoute } from "./route-evidence-match.ts";
import { routeReloadSnapshot } from "./route-reload-snapshot.ts";
import { isAcknowledged, routeReloadDigest } from "./route-reload-state.ts";
import { authoritiesFor, routeSchemes } from "./routing.ts";
import { normalizeDefaultDomain } from "./tls.ts";

export const observeRoutes = Effect.fn("TraefikRouter.observeRoutes")(function* (
  dependencies: TraefikProxyDependencies,
  app: AppId,
  requestedRoutes: ReadonlyArray<RoutePlan>,
): Effect.fn.Return<RouteEvidence> {
  const acquisition = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  const ports =
    acquisition === undefined ? undefined : { http: acquisition.httpPort, https: acquisition.httpsPort };
  const configuredAuthorities = ports === undefined ? [] : authoritiesFor(requestedRoutes, ports);
  const unknown: RouteEvidence = { configuredAuthorities, observation: { status: "unknown" } };
  if (requestedRoutes.length === 0) return { configuredAuthorities, observation: { status: "missing" } };
  if (
    acquisition === undefined ||
    ports === undefined ||
    dependencies.httpClient === undefined ||
    dependencies.globalApp.ownedPublishPorts === undefined
  )
    return unknown;
  const http = HttpClient.withScope(dependencies.httpClient);
  const requestPolicy = yield* RequestPolicy;
  const host =
    acquisition.fingerprint.bindAddress === "0.0.0.0"
      ? "127.0.0.1"
      : acquisition.fingerprint.bindAddress === "::"
        ? "::1"
        : acquisition.fingerprint.bindAddress;
  const physical = {
    http: acquisition.bindHttpPort ?? acquisition.httpPort,
    https: acquisition.bindHttpsPort ?? acquisition.httpsPort,
  };
  const result = yield* Effect.gen(function* () {
    const domain = normalizeDefaultDomain(
      yield* dependencies.fileSystem.readText(defaultDomainFile(dependencies.paths)),
    );
    const request = (scheme: "http" | "https", path: string) => {
      const url = new URL(`${scheme}://traefik.${domain}:${ports[scheme]}${path}`);
      return http.execute(HttpClientRequest.get(url.href)).pipe(
        Effect.provideService(RequestPolicy, {
          ...requestPolicy,
          redirect: "manual",
          connectionTarget: { address: host, origin: url.origin },
        }),
      );
    };
    const schemes = [...new Set(requestedRoutes.flatMap(routeSchemes))];
    const owned = yield* dependencies.globalApp.ownedPublishPorts?.(
      ServiceName.make("traefik"),
      [...new Set([physical.http, ...schemes.map((scheme) => physical[scheme])])].map((port) =>
        PortNumber.make(port),
      ),
    ) ?? Effect.succeed([]);
    if (!owned.includes(physical.http)) return unknown;
    const ingress = yield* Effect.forEach(schemes, (scheme) =>
      Effect.gen(function* () {
        if (!owned.includes(physical[scheme])) return false;
        if (dependencies.probeForward !== undefined) {
          const probe = yield* dependencies.probeForward(host, ports[scheme], scheme);
          return probe.kind === "success";
        }
        return yield* request(scheme, "/").pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      }),
    );
    // The SDK cannot mark an individual unlisted scheme inconclusive in `present`.
    // Keep the whole observation unknown rather than turn a failed probe into absence.
    if (ingress.some((proven) => !proven)) return unknown;
    const response = yield* request("http", "/api/rawdata");
    if (response.status !== 200 || !response.headers["content-type"]?.includes("application/json"))
      return unknown;
    // Client JSON failures can emit body fragments through HTTP telemetry.
    const snapshot = Option.getOrUndefined(decodeRouteSnapshot(yield* response.text));
    if (snapshot === undefined) return unknown;
    const matches = requestedRoutes.flatMap((route) =>
      routeSchemes(route).map((scheme) => ({
        matched: matchesLiveRoute(snapshot, app, { route, scheme }),
        publication: { route, authority: { hostname: route.hostname, scheme, port: ports[scheme] } },
      })),
    );
    if (matches.some(({ matched }) => matched === undefined)) return unknown;
    const publications = matches.flatMap(({ matched, publication }) => (matched ? [publication] : []));
    return {
      configuredAuthorities,
      observation: publications.length === 0 ? { status: "missing" } : { status: "present", publications },
    } satisfies RouteEvidence;
  }).pipe(
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(unknown)),
    Effect.scoped,
  );
  return result;
});

export const makeRouteObserver = (
  dependencies: TraefikProxyDependencies,
  pendingReload: ReadonlySet<string>,
) =>
  Effect.fn("TraefikRouter.observeRouteEvidence")(function* (
    app: AppId,
    requestedRoutes: ReadonlyArray<RoutePlan>,
  ) {
    const evidence = yield* observeRoutes(dependencies, app, requestedRoutes);
    if (dependencies.paths.platform !== "win32" || evidence.observation.status !== "present") return evidence;
    const unknown: RouteEvidence = {
      configuredAuthorities: evidence.configuredAuthorities,
      observation: { status: "unknown" },
    };
    const stateStore = dependencies.stateStore;
    if (stateStore === undefined || pendingReload.has(String(app))) return unknown;
    const acknowledged = yield* Effect.gen(function* () {
      const domain = yield* dependencies.fileSystem.readText(defaultDomainFile(dependencies.paths));
      const snapshot = yield* routeReloadSnapshot(dependencies, app, normalizeDefaultDomain(domain));
      return yield* isAcknowledged(stateStore, app, routeReloadDigest(snapshot));
    }).pipe(Effect.catch(() => Effect.succeed(false)));
    return acknowledged ? evidence : unknown;
  });
