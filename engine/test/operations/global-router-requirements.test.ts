import { expect, test } from "bun:test";
import { ProxyError } from "@lando/sdk/errors";
import { ServiceName } from "@lando/sdk/schema";
import {
  AppPlanner,
  BuildOrchestrator,
  RouterService,
  type RouterServiceShape,
  RuntimeProviderRegistry,
} from "@lando/sdk/services";
import { TestRouterService } from "@lando/sdk/test";
import { Effect, Layer } from "effect";
import {
  type GlobalRebuildError,
  type GlobalRebuildServices,
  globalRebuild,
} from "../../src/operations/global-rebuild.ts";
import {
  type GlobalRestartError,
  type GlobalRestartServices,
  globalRestart,
} from "../../src/operations/global-restart.ts";
import { globalStart } from "../../src/operations/global-start.ts";
import { makeUnavailableRouter } from "../../src/subsystems/proxy/api.ts";
import { makeHarness } from "./start-progress-topology-support.ts";

const missingRouter = makeUnavailableRouter(
  new ProxyError({
    message: "Router service missing is not installed.",
    proxyId: "missing",
    remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
  }),
);

const routedGlobal = () => {
  const calls: string[] = [];
  const harness = makeHarness({
    globalServiceIds: ["mail", "db"],
    onDestroy: (target) => void calls.push(`destroy:${target.app}`),
  });
  const mail = ServiceName.make("mail");
  const plan: typeof harness.globalAdmission.globalPlan = {
    ...harness.globalAdmission.globalPlan,
    router: { enabled: true },
    routes: [
      {
        hostname: "mail.lndo.site",
        priority: 2,
        scheme: "http",
        service: mail,
        endpoint: 8025,
        backend: { service: mail, protocol: "http", port: 8025 },
      },
    ],
  };
  const layer = (router: RouterServiceShape) =>
    Layer.mergeAll(
      harness.layer,
      Layer.succeed(RouterService, router),
      Layer.succeed(AppPlanner, AppPlanner.of({ plan: () => Effect.succeed(plan) })),
      Layer.succeed(
        BuildOrchestrator,
        BuildOrchestrator.of({
          build: (built) => Effect.sync(() => void calls.push("build")).pipe(Effect.as(built)),
          buildApp: () => Effect.sync(() => void calls.push("buildApp")),
        }),
      ),
    );
  return { harness, calls, layer };
};

const selectionFailure = {
  _tag: "Failure",
  failure: {
    _tag: "ProxySetupError",
    proxyId: "missing",
  },
};

type Operation = () => Effect.Effect<
  void,
  GlobalRestartError | GlobalRebuildError,
  GlobalRestartServices | GlobalRebuildServices
>;
const operations: ReadonlyArray<{ readonly name: string; readonly operation: Operation }> = [
  { name: "global start", operation: () => Effect.asVoid(globalStart()) },
  { name: "selected global start", operation: () => Effect.asVoid(globalStart({ services: ["mail"] })) },
  { name: "global restart", operation: () => Effect.asVoid(globalRestart()) },
  { name: "global rebuild", operation: () => Effect.asVoid(globalRebuild()) },
];

test.each(operations)(
  "#2138 a routed $name without a selectable router refuses before destroy, build, or apply",
  async ({ operation }) => {
    // Given: a running global app whose `mail` route was published through a selectable router.
    const fixture = routedGlobal();
    await Effect.runPromise(globalStart().pipe(Effect.provide(fixture.layer(TestRouterService))));
    const running = fixture.harness.globalAdmission.appliedPlan();
    expect(running).toBeDefined();
    fixture.calls.length = 0;

    // When: the operation runs after the configured router stopped being selectable.
    const result = await Effect.runPromise(
      operation().pipe(Effect.result, Effect.provide(fixture.layer(missingRouter))),
    );

    // Then: it reports the selection reason and the running services were not destroyed, rebuilt, or reapplied.
    expect(result).toMatchObject(selectionFailure);
    expect(fixture.calls).toEqual([]);
    expect(fixture.harness.globalAdmission.appliedPlan()).toBe(running);
  },
);

test("#2138 a selected global start refuses when sibling reconciliation joins a routed service", async () => {
  // Given: `db` publishes no route, while `mail`, whose route needs a router, runs without saved state,
  // so reconciliation joins it to a `db` start; and no router is selectable.
  const fixture = routedGlobal();
  const plan = fixture.harness.globalAdmission.globalPlan;
  const mail = {
    app: plan.id,
    appRoot: plan.root,
    providerId: plan.provider,
    service: ServiceName.make("mail"),
    containerId: "mail-container",
    status: "running" as const,
    labels: { "dev.lando.app": plan.id, "dev.lando.app-root": plan.root, "dev.lando.service": "mail" },
    publications: { status: "unknown" as const },
  };
  const base = fixture.layer(missingRouter);
  const withRunningMail = Layer.effect(
    RuntimeProviderRegistry,
    Effect.map(RuntimeProviderRegistry, (registry) =>
      RuntimeProviderRegistry.of({
        ...registry,
        select: (target) =>
          Effect.map(registry.select(target), (provider) => ({
            ...provider,
            list: (filter) => Effect.map(provider.list(filter), (rows) => [...rows, mail]),
          })),
      }),
    ),
  ).pipe(Layer.provide(base));

  // When
  const result = await Effect.runPromise(
    globalStart({ services: ["db"] }).pipe(Effect.result, Effect.provide(Layer.merge(base, withRunningMail))),
  );

  // Then: it reports the selection reason before building or applying anything.
  expect(result).toMatchObject(selectionFailure);
  expect(fixture.calls).toEqual([]);
  expect(fixture.harness.globalAdmission.appliedPlan()).toBeUndefined();
});
