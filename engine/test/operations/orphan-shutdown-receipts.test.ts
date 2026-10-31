import { expect, test } from "bun:test";
import {
  AbsolutePath,
  AppId,
  ProviderId,
  ServiceName,
  type ServiceShutdownObservation,
} from "@lando/sdk/schema";
import { RouterService, type ServiceRuntimeInfo } from "@lando/sdk/services";
import { TestRuntimeProvider, makeTestRouterService } from "@lando/sdk/test";
import { Effect } from "effect";
import {
  executeGlobalStopSelection,
  resolveGlobalStopSelection,
} from "../../src/operations/global-teardown.ts";
import { tearDownOrphans } from "../../src/operations/orphan-teardown.ts";
import { harness as globalHarness, id as globalId } from "./global-stop-selection-fixture.ts";
import { makeHarness, plan } from "./start-progress-topology-support.ts";

test("orphan teardown preserves attributed observations when service names repeat across roots", async () => {
  // Given
  const appA = AppId.make("app-a");
  const appB = AppId.make("app-b");
  const service = ServiceName.make("web");
  const providerId = ProviderId.make("lando");
  const obsA: ServiceShutdownObservation = {
    appId: appA,
    providerId,
    service,
    containerId: "a-web",
    status: "exited",
    exitCode: 0,
  };
  const obsB: ServiceShutdownObservation = {
    appId: appB,
    providerId,
    service,
    containerId: "b-web",
    status: "exited",
    exitCode: 137,
    oomKilled: true,
  };
  const absent: ServiceShutdownObservation = {
    appId: appB,
    providerId,
    service: ServiceName.make("cache"),
    status: "unknown",
    reason: "container-absent",
  };
  const provider = {
    ...TestRuntimeProvider,
    removeObservedService: (observed: ServiceRuntimeInfo) =>
      Effect.succeed(
        observed.service === "cache"
          ? { kind: "absent" as const, shutdownObservations: [absent] }
          : { kind: "removed" as const, shutdownObservations: [observed.app === appA ? obsA : obsB] },
      ),
  };
  const harness = makeHarness({
    selectProvider: () => Effect.succeed(provider),
    resolveTeardownEvidence: () => Effect.succeed({ kind: "absent" }),
  });
  const row = (app: typeof appA, containerId: string): ServiceRuntimeInfo => ({
    app,
    providerId,
    service,
    appRoot: AbsolutePath.make(`${plan.root}/${app}`),
    containerId,
    status: "exited",
    publications: { status: "unknown" },
  });
  // When
  const result = await Effect.runPromise(
    tearDownOrphans({
      root: plan.root,
      groups: [
        { appId: appA, providerId, volumes: [], services: [row(appA, "a-web")] },
        {
          appId: appB,
          providerId,
          volumes: [],
          services: [
            row(appB, "b-web"),
            {
              app: appB,
              providerId,
              service: ServiceName.make("cache"),
              appRoot: AbsolutePath.make(`${plan.root}/${appB}`),
              status: "created",
              publications: { status: "unknown" },
            },
          ],
        },
      ],
      options: { volumes: false, purgeCaches: false },
    }).pipe(Effect.provide(harness.layer)),
  );
  // Then
  expect(result.services).toEqual(["web"]);
  expect(result.shutdownObservations).toEqual([obsA, obsB, absent]);
});

test("global selected stop preserves absent removal observations", async () => {
  // Given
  const absent: ServiceShutdownObservation = {
    appId: globalId,
    providerId: ProviderId.make("lando"),
    service: ServiceName.make("mail"),
    containerId: "mail-container",
    status: "unknown",
    reason: "container-absent",
  };
  const h = globalHarness({ race: true });
  const resolved = {
    ...h.resolved,
    provider: {
      ...h.resolved.provider,
      removeObservedService: () =>
        Effect.succeed({ kind: "absent" as const, shutdownObservations: [absent] }),
    },
  };
  // When
  const receipt = await Effect.runPromise(
    Effect.gen(function* () {
      const selection = yield* resolveGlobalStopSelection(resolved, ["mail"]);
      return yield* executeGlobalStopSelection(resolved, selection);
    }).pipe(
      Effect.provideService(RouterService, {
        ...makeTestRouterService(),
        setup: () => Effect.die("selected stop must not set up routes"),
        removeRoutes: () => Effect.die("selected stop must not delete whole route file"),
        applyRoutes: (routes) => Effect.succeed({ app: globalId, appliedRoutes: routes, authorities: [] }),
      }),
    ),
  );
  // Then
  expect(receipt).toEqual({ changed: false, services: [], shutdownObservations: [absent] });
});
