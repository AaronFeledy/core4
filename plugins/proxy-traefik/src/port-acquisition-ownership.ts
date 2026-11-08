import { Effect } from "effect";

import { ServiceName } from "@lando/sdk/schema";

import type { ProbedAcquisition } from "./port-acquisition-helpers.ts";
import { type BindOutcome, probeBind } from "./port-acquisition.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { readHelperHopTargets } from "./socket-proxy-install.ts";

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

export const usableHelperHopTargets = Effect.fn("TraefikRouter.usableHelperHopTargets")(function* (
  dependencies: TraefikProxyDependencies,
  probed: ProbedAcquisition,
  bindAddress: string,
) {
  if (dependencies.socketProxy === undefined) return undefined;
  const targets = yield* readHelperHopTargets(dependencies.socketProxy);
  if (targets === undefined) return undefined;
  const binds = yield* Effect.forEach([targets.httpTarget, targets.httpsTarget], (port) => {
    const bind = probed.httpBinds[port] ?? probed.httpsBinds[port];
    return (
      bind === undefined ? (dependencies.probeBind ?? probeBind)(bindAddress, port) : Effect.succeed(bind)
    ).pipe(Effect.map((observed) => ({ port, bind: observed })));
  });
  const owned = yield* ownedRouterPorts(
    dependencies,
    binds.filter(({ bind }) => bind.kind === "EADDRINUSE").map(({ port }) => port),
  );
  return binds.every(
    ({ port, bind }) => bind.kind === "success" || (bind.kind === "EADDRINUSE" && owned.has(port)),
  )
    ? targets
    : undefined;
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
