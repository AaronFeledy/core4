import { RequestPolicy } from "@lando/http-client";
import { NetworkTrust } from "@lando/http-client/network-trust";
import { PortNumber, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { Effect, Option } from "effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import { defaultDomainFile, defaultIssuerFile } from "./proxy-paths.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { decodeRouteSnapshot } from "./route-evidence-match.ts";
import { advertisedRouterBindAddress, routerProbeHost } from "./router-bind-address.ts";
import { routeSchemes } from "./routing.ts";
import { normalizeDefaultDomain } from "./tls.ts";

// Shared acquisition below the Windows acknowledgement gate. Each attempt owns
// its HTTP resources; only decoded graph evidence escapes the request scope.
export const readLiveRouteSnapshot = Effect.fn("TraefikRouter.readLiveRouteSnapshot")(
  function* (dependencies: TraefikProxyDependencies, requestedRoutes: ReadonlyArray<RoutePlan>) {
    const acquisition = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
    if (
      acquisition === undefined ||
      dependencies.httpClient === undefined ||
      dependencies.globalApp.ownedPublishPorts === undefined
    )
      return undefined;
    const ports = { http: acquisition.httpPort, https: acquisition.httpsPort };
    const http = HttpClient.withScope(dependencies.httpClient);
    const requestPolicy = yield* RequestPolicy;
    const host = routerProbeHost(advertisedRouterBindAddress(acquisition));
    const physical = {
      http: acquisition.bindHttpPort ?? ports.http,
      https: acquisition.bindHttpsPort ?? ports.https,
    };
    const domain = normalizeDefaultDomain(
      yield* dependencies.fileSystem.readText(defaultDomainFile(dependencies.paths)),
    );
    const request = (scheme: "http" | "https", path: string) => {
      const url = new URL(`${scheme}://traefik.${domain}:${ports[scheme]}${path}`);
      const response = http.execute(HttpClientRequest.get(url.href)).pipe(
        Effect.provideService(RequestPolicy, {
          ...requestPolicy,
          redirect: "manual",
          connectionTarget: { address: host, origin: url.origin },
        }),
      );
      if (scheme === "http") return response;
      return dependencies.fileSystem.readText(defaultIssuerFile(dependencies.paths, domain)).pipe(
        Effect.flatMap((issuer) =>
          response.pipe(
            Effect.provideService(NetworkTrust, {
              proxy: { noProxy: [] },
              caPems: [issuer],
              trustHost: false,
            }),
          ),
        ),
      );
    };
    const schemes = [...new Set(requestedRoutes.flatMap(routeSchemes))];
    const owned = yield* dependencies.globalApp.ownedPublishPorts(
      ServiceName.make("traefik"),
      [...new Set([physical.http, ...schemes.map((scheme) => physical[scheme])])].map((port) =>
        PortNumber.make(port),
      ),
    );
    if (!owned.includes(physical.http)) return undefined;
    const ingress = yield* Effect.forEach(schemes, (scheme) =>
      Effect.gen(function* () {
        if (!owned.includes(physical[scheme])) return false;
        if (dependencies.probeForward !== undefined) {
          return (yield* dependencies.probeForward(host, ports[scheme], scheme)).kind === "success";
        }
        return yield* request(scheme, "/").pipe(
          Effect.as(true),
          Effect.catch(() => Effect.succeed(false)),
        );
      }),
    );
    if (ingress.some((proven) => !proven)) return undefined;
    const response = yield* request("http", "/api/rawdata");
    if (response.status !== 200 || !response.headers["content-type"]?.includes("application/json"))
      return undefined;
    // JSON decoder errors must never carry raw API fragments into telemetry.
    return Option.getOrUndefined(decodeRouteSnapshot(yield* response.text));
  },
  (effect) =>
    effect.pipe(
      Effect.scoped,
      Effect.catch(() => Effect.succeed(undefined)),
    ),
);
