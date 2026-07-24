import { Effect } from "effect";

import { AppId, type ProxyApplyResult, type RoutePlan, ServiceName } from "../schema/index.ts";
import type { ProxyServiceShape } from "../services/index.ts";
import { ContractFailure } from "./_shared.ts";

const failure = (assertion: string, details?: unknown): ContractFailure =>
  new ContractFailure({ message: `ProxyService contract failed: ${assertion}`, assertion, details });

const requireContract = (
  condition: boolean,
  assertion: string,
  details?: unknown,
): Effect.Effect<void, ContractFailure> =>
  condition ? Effect.void : Effect.fail(failure(assertion, details));

export interface ProxyServiceContractHarness {
  readonly service: ProxyServiceShape;
  readonly readRoutes: (app: AppId) => Effect.Effect<ReadonlyArray<RoutePlan>>;
}

const contractRoutes = (): ReadonlyArray<RoutePlan> => [
  {
    hostname: "*.contract-test-app.lndo.site",
    scheme: "both",
    service: ServiceName.make("web"),
    pathPrefix: "/api",
    backend: { service: ServiceName.make("web"), protocol: "http", port: 8088 },
  },
  {
    hostname: "secure.contract-test-app.lndo.site",
    scheme: "https",
    service: ServiceName.make("secure"),
    backend: { service: ServiceName.make("secure"), protocol: "https", port: 9443 },
  },
];

export const runProxyServiceContractSuite = (
  harness: ProxyServiceContractHarness,
): Effect.Effect<void, ContractFailure> =>
  Effect.gen(function* () {
    const proxy = harness.service;
    yield* requireContract(typeof proxy.id === "string" && proxy.id.length > 0, "id is non-empty", proxy.id);
    yield* Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })).pipe(
      Effect.mapError((cause) => failure("setup resolves", cause)),
    );
    yield* Effect.scoped(proxy.setup({ defaultDomain: "lndo.site" })).pipe(
      Effect.mapError((cause) => failure("setup is idempotent", cause)),
    );
    yield* requireContract(proxy.capabilities.wildcardHostnames, "declares wildcard hostname support");
    yield* requireContract(proxy.capabilities.tls, "declares TLS intent support");
    yield* requireContract(proxy.capabilities.pathPrefixes, "declares path-prefix support");

    const app = AppId.make("contract-test-app");
    const routes = contractRoutes();
    const result = yield* proxy
      .applyRoutes(routes, app)
      .pipe(Effect.mapError((cause) => failure("applyRoutes resolves", cause)));
    yield* requireContract(result.app === app, "apply result identifies the app", result);
    yield* requireContract(result.appliedRoutes.length === 2, "apply result reports every route", result);
    yield* requireContract(
      result.authorities.some((authority) => authority.scheme === "https" && authority.port !== 80),
      "apply result reports proxy-selected external authorities",
      result,
    );

    const applied = yield* harness.readRoutes(app);
    yield* requireContract(
      applied[0]?.backend.port === 8088 && applied[1]?.backend.protocol === "https",
      "preserves named non-80 and HTTPS backends",
      applied,
    );

    const replacementResult = yield* proxy
      .applyRoutes(routes.slice(1), app)
      .pipe(Effect.mapError((cause) => failure("re-apply resolves", cause)));
    const reconciled = yield* harness.readRoutes(app);
    yield* requireContract(
      replacementResult.appliedRoutes.length === 1 && reconciled.length === 1,
      "re-apply removes stale routes",
      { replacementResult, reconciled },
    );

    const status = yield* proxy.status.pipe(Effect.mapError((cause) => failure("status resolves", cause)));
    yield* requireContract(status.state === "running", "status reports running after setup", status);
    yield* proxy.stop.pipe(Effect.mapError((cause) => failure("stop resolves", cause)));
    const stopped = yield* proxy.status.pipe(
      Effect.mapError((cause) => failure("status resolves after stop", cause)),
    );
    yield* requireContract(
      stopped.state === "stopped" && stopped.configuredApps.length === 0,
      "stop durably removes configured routing without requiring process-local state",
      stopped,
    );
    yield* requireContract((yield* harness.readRoutes(app)).length === 0, "stop clears routes");
    yield* proxy.removeRoutes(app).pipe(Effect.mapError((cause) => failure("removeRoutes resolves", cause)));
    yield* proxy
      .removeRoutes(app)
      .pipe(Effect.mapError((cause) => failure("removeRoutes is idempotent", cause)));
    yield* requireContract((yield* harness.readRoutes(app)).length === 0, "removeRoutes clears routes");
  });

export const makeProxyServiceContractSuite = runProxyServiceContractSuite;

export const makeTestProxyService = (): ProxyServiceShape & {
  readonly routesByApp: ReadonlyMap<string, ReadonlyArray<RoutePlan>>;
  readonly readRoutes: (app: AppId) => Effect.Effect<ReadonlyArray<RoutePlan>>;
} => {
  const routesByApp = new Map<string, ReadonlyArray<RoutePlan>>();
  let running = false;
  return {
    id: "test",
    capabilities: { wildcardHostnames: true, tls: true, pathPrefixes: true },
    setup: () =>
      Effect.sync(() => {
        running = true;
      }),
    applyRoutes: (routes, app) =>
      Effect.sync((): ProxyApplyResult => {
        routesByApp.set(String(app), routes);
        return {
          app,
          appliedRoutes: routes,
          authorities: routes.flatMap((route) =>
            (route.scheme === "both" ? (["http", "https"] as const) : [route.scheme]).map((scheme) => ({
              scheme,
              hostname: route.hostname,
              port: scheme === "https" ? 38443 : 38080,
            })),
          ),
        };
      }),
    removeRoutes: (app) => Effect.sync(() => void routesByApp.delete(String(app))),
    status: Effect.sync(() => ({
      state: running ? ("running" as const) : ("stopped" as const),
      authorities: [],
      configuredApps: [...routesByApp.keys()].map((app) => AppId.make(app)),
    })),
    stop: Effect.sync(() => {
      running = false;
      routesByApp.clear();
    }),
    readRoutes: (app) => Effect.succeed(routesByApp.get(String(app)) ?? []),
    routesByApp,
  };
};

export const TestProxyService = makeTestProxyService();
