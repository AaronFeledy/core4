import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Layer, Semaphore } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { ProxySetupError, StateStoreError } from "@lando/sdk/errors";
import { GlobalAppService, PathsService, RouterService, StateStore } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";

import { withGlobalMutation } from "../../src/global-app/enablement.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { RouterServiceRegistry, layerSelected } from "../../src/subsystems/proxy/registry.ts";
import { makeTestStateStore } from "../../src/testing/state-store.ts";

const unusedRouterDependencies = Layer.mergeAll(
  BunFileSystem.layer,
  Layer.succeed(PathsService, makeLandoPaths()),
  Layer.succeed(
    GlobalAppService,
    GlobalAppService.of({
      id: "global",
      root: Effect.die("Router test must not resolve a global root."),
      providerId: Effect.die("Router test must not resolve a provider."),
      paths: Effect.die("Router test must not read global paths."),
      ensureRoot: Effect.die("Router test must not create a global root."),
      ensureUserLandofile: Effect.die("Router test must not create a Landofile."),
      ensureRunning: () => Effect.die("Router test uses its explicit nested ensure."),
      regenerateDist: () => Effect.die("Router test must not regenerate configuration."),
    }),
  ),
  Layer.succeed(
    CertificateAuthorityResolver,
    CertificateAuthorityResolver.of({
      resolve: Effect.die("Router selection must not resolve a certificate authority."),
    }),
  ),
);

const selectedRouter = (router: typeof RouterService.Service, store: typeof StateStore.Service) =>
  layerSelected.pipe(
    Layer.provide(
      Layer.mergeAll(
        unusedRouterDependencies,
        Layer.succeed(StateStore, store),
        Layer.succeed(
          RouterServiceRegistry,
          RouterServiceRegistry.of({
            list: Effect.succeed([router.id]),
            select: () => Effect.succeed({ id: router.id, layer: Layer.succeed(RouterService, router) }),
          }),
        ),
      ),
    ),
  );

test("selected router setup takes the global lock before its route lock and nested ensure reuses it", async () => {
  const state = makeTestStateStore();
  const routeLock = Semaphore.makeUnsafe(1);
  const routeHeld = Deferred.makeUnsafe<void>();
  const allowEnsure = Deferred.makeUnsafe<void>();
  const mutationWaiting = Deferred.makeUnsafe<void>();
  const timeline: string[] = [];
  let acquisitions = 0;
  const store = StateStore.of({
    ...state.service,
    withLock: (key, body) =>
      Effect.gen(function* () {
        acquisitions++;
        if (acquisitions === 2) yield* Deferred.succeed(mutationWaiting, undefined);
        return yield* state.service.withLock(key, body);
      }),
  });
  const router = RouterService.of({
    ...makeTestRouterService(),
    setup: () =>
      routeLock.withPermits(1)(
        Effect.gen(function* () {
          timeline.push("setup:route");
          yield* Deferred.succeed(routeHeld, undefined);
          yield* Deferred.await(allowEnsure);
          yield* withGlobalMutation(Effect.sync(() => timeline.push("setup:ensure"))).pipe(
            Effect.provideService(StateStore, store),
            Effect.mapError(
              (cause) =>
                new ProxySetupError({
                  proxyId: "test",
                  message: "Nested ensure failed.",
                  remediation: cause.remediation,
                  cause,
                }),
            ),
          );
        }),
      ),
  });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const selected = yield* RouterService;
        const setup = yield* Effect.forkScoped(selected.setup({ defaultDomain: "lndo.site" }));
        yield* Deferred.await(routeHeld);
        const mutation = yield* Effect.forkScoped(
          withGlobalMutation(
            routeLock.withPermits(1)(Effect.sync(() => timeline.push("mutation:routes"))),
          ).pipe(Effect.provideService(StateStore, store)),
        );
        yield* Deferred.await(mutationWaiting);
        yield* Deferred.succeed(allowEnsure, undefined);
        yield* Fiber.join(setup);
        yield* Fiber.join(mutation);
      }),
    ).pipe(Effect.provide(selectedRouter(router, store)), Effect.timeout("2 seconds")),
  );
  expect(timeline).toEqual(["setup:route", "setup:ensure", "mutation:routes"]);
  expect(acquisitions).toBe(2);
});

test("selected router reports lock failure as ProxySetupError without invoking plugin setup", async () => {
  const state = makeTestStateStore();
  let invoked = false;
  const store = StateStore.of({
    ...state.service,
    withLock: () =>
      Effect.fail(
        new StateStoreError({
          reason: "lock",
          operation: "withLock",
          path: "/private/global-lock",
          remediation: "Wait for the other global command and retry.",
        }),
      ),
  });
  const router = RouterService.of({
    ...makeTestRouterService(),
    setup: () =>
      Effect.sync(() => {
        invoked = true;
      }),
  });
  const result = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const selected = yield* RouterService;
        return yield* Effect.result(selected.setup({ defaultDomain: "lndo.site" }));
      }),
    ).pipe(Effect.provide(selectedRouter(router, store))),
  );
  expect(result._tag).toBe("Failure");
  if (result._tag === "Failure") {
    expect(result.failure).toBeInstanceOf(ProxySetupError);
    expect(result.failure).toMatchObject({ proxyId: router.id, cause: { _tag: "GlobalAppError" } });
  }
  expect(invoked).toBe(false);
});

test("an empty router catalog never opens global state or acquires its mutation lock", async () => {
  const noRouters = Layer.succeed(
    RouterServiceRegistry,
    RouterServiceRegistry.of({
      list: Effect.succeed([]),
      select: () => Effect.die("Empty catalog must not select a router."),
    }),
  );
  const unusedState = Layer.succeed(
    StateStore,
    StateStore.of({
      open: () => Effect.die("Empty router catalog must not open global state."),
      withLock: () => Effect.die("Empty router catalog must not acquire a lock."),
    }),
  );
  const router = await Effect.runPromise(
    RouterService.pipe(
      Effect.provide(
        layerSelected.pipe(Layer.provide(Layer.mergeAll(noRouters, unusedState, unusedRouterDependencies))),
      ),
    ),
  );
  expect(router.id).toBe("unavailable");
});
