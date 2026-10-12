import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import type { ProbedAcquisition } from "./port-acquisition-helpers.ts";
import type { BindOutcome } from "./port-acquisition.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";

export const ownedRouterPorts = Effect.fn("TraefikRouter.ownedRouterPorts")(function* (
  dependencies: TraefikProxyDependencies,
  occupied: readonly number[],
) {
  const query = dependencies.globalApp.ownedPublishPorts;
  if (occupied.length === 0 || query === undefined) return new Set<number>();
  // Without provider ownership proof, keep the conservative occupied-port verdict.
  // A failed query must not prevent acquisition from choosing a free fallback.
  const owned = yield* query(ServiceName.make("traefik"), occupied).pipe(
    Effect.catch(() => Effect.succeed([])),
  );
  return new Set<number>(owned);
});

export const reclaimRouterPorts = Effect.fn("TraefikRouter.reclaimRouterPorts")(function* (
  dependencies: TraefikProxyDependencies,
  probed: ProbedAcquisition,
  preferred: { readonly http: number; readonly https: number },
) {
  const occupied = [
    ...new Set(
      [...Object.entries(probed.httpBinds), ...Object.entries(probed.httpsBinds)]
        .filter(([, bind]) => bind.kind === "EADDRINUSE")
        .map(([port]) => Number(port)),
    ),
  ];
  const owned = yield* ownedRouterPorts(dependencies, occupied);
  const available = (binds: Readonly<Record<number, BindOutcome>>) =>
    Object.fromEntries(
      Object.entries(binds).map(([port, bind]): [string, BindOutcome] => [
        port,
        bind.kind === "EADDRINUSE" && owned.has(Number(port)) ? { kind: "success" } : bind,
      ]),
    );
  return {
    ...probed,
    httpBinds: available(probed.httpBinds),
    httpsBinds: available(probed.httpsBinds),
    http:
      probed.http.bind.kind === "EADDRINUSE" && owned.has(preferred.http)
        ? { bind: { kind: "success" as const }, forward: { kind: "failure" as const } }
        : probed.http,
    https:
      probed.https.bind.kind === "EADDRINUSE" && owned.has(preferred.https)
        ? { bind: { kind: "success" as const }, forward: { kind: "failure" as const } }
        : probed.https,
  };
});
