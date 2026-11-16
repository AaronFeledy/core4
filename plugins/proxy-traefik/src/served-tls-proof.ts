import { observeTlsPeer } from "@lando/http-client/tls-peer";
import { LEAF_RENEWAL_MARGIN_MS, certificateIsCurrent } from "@lando/sdk/certificates";
import { PortNumber, type RoutePlan, ServiceName } from "@lando/sdk/schema";
import { Clock, Effect } from "effect";
import { readAcquisitionState } from "./port-acquisition-state.ts";
import type { TraefikProxyDependencies } from "./proxy-types.ts";
import { advertisedRouterBindAddress, routerProbeHost } from "./router-bind-address.ts";
import type { PreparedRouterTls } from "./tls.ts";

export type ServedTlsProof = {
  readonly domain: string;
  readonly tls: PreparedRouterTls;
};

export const proveServedTls = Effect.fn("TraefikRouter.proveServedTls")(function* (
  dependencies: TraefikProxyDependencies,
  routes: readonly RoutePlan[],
  preparation: ServedTlsProof,
) {
  const acquisition = yield* readAcquisitionState(dependencies.fileSystem, dependencies.paths);
  if (acquisition === undefined || dependencies.globalApp.ownedPublishPorts === undefined) return false;
  const port = acquisition.httpsPort;
  const physical = acquisition.bindHttpsPort ?? port;
  const owned = yield* dependencies.globalApp.ownedPublishPorts(ServiceName.make("traefik"), [
    PortNumber.make(physical),
  ]);
  if (!owned.includes(physical)) return false;
  const address = routerProbeHost(advertisedRouterBindAddress(acquisition));
  const appNames = routes
    .filter((route) => route.scheme !== "http")
    .map((route) => route.hostname.toLowerCase().replace(/^[^.]+/, (label) => label.replaceAll("*", "x")));
  const names = [
    ...new Set([...appNames, preparation.domain, `traefik.${preparation.domain}`, `x.${preparation.domain}`]),
  ];
  const roots = [...new Set([preparation.tls.app.pair.root, preparation.tls.defaults.pair.root])];
  const results = yield* Effect.forEach(
    names,
    (hostname) =>
      Effect.gen(function* () {
        const certificate = yield* (dependencies.observeTlsPeer ?? observeTlsPeer)({
          hostname,
          port,
          address,
          caPems: roots,
        });
        const now = yield* Clock.currentTimeMillis;
        const root = appNames.includes(hostname)
          ? preparation.tls.app.pair.root
          : preparation.tls.defaults.pair.root;
        return certificateIsCurrent(certificate, {
          names: [hostname],
          root,
          now,
          renewalMarginMs: LEAF_RENEWAL_MARGIN_MS,
        });
      }).pipe(Effect.catch(() => Effect.succeed(false))),
    { concurrency: 4 },
  );
  return results.every(Boolean);
});
