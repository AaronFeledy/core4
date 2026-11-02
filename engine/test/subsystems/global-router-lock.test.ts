import { expect, test } from "bun:test";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Deferred, Effect, Fiber, Layer, Semaphore, Stream } from "effect";

import { makeLandoPaths } from "@lando/paths";
import { ProxySetupError } from "@lando/sdk/errors";
import { AbsolutePath, ProviderId } from "@lando/sdk/schema";
import { EventService, GlobalAppService, PathsService, RouterService, StateStore } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { makeStateStore } from "@lando/state-store/service";

import { type GlobalMutationServices, withGlobalMutation } from "../../src/global-app/mutation.ts";
import { appMutationLockKey } from "../../src/operations/app-mutation-lock.ts";
import { CertificateAuthorityResolver } from "../../src/plugins/certificate-authority-resolver.ts";
import * as BunFileSystem from "../../src/services/file-system.ts";
import { RouterServiceRegistry, layerSelected } from "../../src/subsystems/proxy/registry.ts";

const fixture = async (onWait = Effect.void) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "lando-router-lock-")));
  const paths = makeLandoPaths({ userDataRoot: root, userConfRoot: join(root, "conf") });
  const globalRoot = paths.globalAppRoot;
  const base = Layer.mergeAll(
    BunFileSystem.layer,
    PrivateFileAccessService.layer,
    Layer.succeed(PathsService, paths),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        root: Effect.succeed(AbsolutePath.make(globalRoot)),
        paths: Effect.succeed({
          root: AbsolutePath.make(globalRoot),
          distLandofile: AbsolutePath.make(join(globalRoot, ".lando.dist.yml")),
          userLandofile: AbsolutePath.make(join(globalRoot, ".lando.yml")),
        }),
        providerId: Effect.succeed(ProviderId.make("docker")),
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
    Layer.succeed(
      EventService,
      EventService.of({
        publish: (event) => (event._tag === "message.warn" ? onWait : Effect.void),
        subscribe: () => Stream.empty,
        subscribeQueue: Effect.die("No event subscription in router lock tests."),
        waitFor: () => Effect.never,
        subscribeWithHistory: () => Effect.never,
        waitForAny: () => Effect.never,
        query: () => Effect.succeed([]),
      }),
    ),
  );
  const dependencies = Layer.effect(
    StateStore,
    Effect.map(PrivateFileAccessService, (access) =>
      makeStateStore({ privateFileAccess: access, roots: paths.roots }),
    ),
  ).pipe(Layer.provideMerge(base));
  const selected = (router: typeof RouterService.Service) =>
    layerSelected.pipe(
      Layer.provideMerge(
        Layer.mergeAll(
          dependencies,
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
  const lockPath = join(
    root,
    `.lando-global-${appMutationLockKey("global", globalRoot)}`,
    `${appMutationLockKey("global", globalRoot)}.lock`,
  );
  return { root, dependencies, selected, lockPath };
};

test("selected router setup takes the global lock before its route lock and nested ensure reuses it", async () => {
  const routeLock = Semaphore.makeUnsafe(1);
  const routeHeld = Deferred.makeUnsafe<void>();
  const allowEnsure = Deferred.makeUnsafe<void>();
  const mutationWaiting = Deferred.makeUnsafe<void>();
  const isolated = await fixture(Deferred.succeed(mutationWaiting, undefined).pipe(Effect.asVoid));
  const mutationContext = await Effect.runPromise(
    Effect.context<GlobalMutationServices>().pipe(Effect.provide(isolated.dependencies)),
  );
  const timeline: string[] = [];
  let outerToken = "";
  let nestedToken = "";
  let peerToken = "";
  const router = RouterService.of({
    ...makeTestRouterService(),
    setup: () =>
      routeLock.withPermits(1)(
        Effect.gen(function* () {
          outerToken = (yield* Effect.promise(() => Bun.file(isolated.lockPath).json())).token;
          timeline.push("setup:route");
          yield* Deferred.succeed(routeHeld, undefined);
          yield* Deferred.await(allowEnsure);
          yield* withGlobalMutation(
            Effect.gen(function* () {
              nestedToken = (yield* Effect.promise(() => Bun.file(isolated.lockPath).json())).token;
              timeline.push("setup:ensure");
            }),
          ).pipe(
            Effect.provide(mutationContext),
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
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const selected = yield* RouterService;
          const setup = yield* Effect.forkScoped(selected.setup({ defaultDomain: "lndo.site" }));
          yield* Deferred.await(routeHeld);
          const mutation = yield* Effect.forkScoped(
            withGlobalMutation(
              routeLock.withPermits(1)(
                Effect.gen(function* () {
                  peerToken = (yield* Effect.promise(() => Bun.file(isolated.lockPath).json())).token;
                  timeline.push("mutation:routes");
                }),
              ),
            ),
          );
          yield* Deferred.await(mutationWaiting);
          yield* Deferred.succeed(allowEnsure, undefined);
          yield* Fiber.join(setup);
          yield* Fiber.join(mutation);
        }),
      ).pipe(Effect.provide(isolated.selected(router)), Effect.timeout("2 seconds")),
    );
    expect(timeline).toEqual(["setup:route", "setup:ensure", "mutation:routes"]);
    expect(nestedToken).toBe(outerToken);
    expect(peerToken).not.toBe(outerToken);
  } finally {
    await rm(isolated.root, { recursive: true, force: true });
  }
});

test("selected router reports coordination failure as ProxySetupError before plugin setup", async () => {
  const isolated = await fixture();
  let invoked = false;
  const router = RouterService.of({
    ...makeTestRouterService(),
    setup: () =>
      Effect.sync(() => {
        invoked = true;
      }),
  });
  const failingAccess = Layer.succeed(
    PrivateFileAccessService,
    PrivateFileAccessService.of({
      enforce: async () => {
        throw new Error("private lock denied");
      },
      verify: async () => undefined,
    }),
  );
  try {
    const selected = layerSelected.pipe(
      Layer.provide(
        Layer.mergeAll(
          isolated.dependencies,
          failingAccess,
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
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const service = yield* RouterService;
        return yield* Effect.result(service.setup({ defaultDomain: "lndo.site" }));
      }).pipe(Effect.provide(selected), Effect.scoped),
    );
    expect(result._tag).toBe("Failure");
    if (result._tag === "Failure")
      expect(result.failure).toMatchObject({
        _tag: "ProxySetupError",
        proxyId: router.id,
        cause: { _tag: "GlobalAppError", operation: "coordination" },
      });
    expect(invoked).toBe(false);
  } finally {
    await rm(isolated.root, { recursive: true, force: true });
  }
});

test("an empty router catalog does not resolve the global root or acquire a lock", async () => {
  const isolated = await fixture();
  const noRouters = Layer.succeed(
    RouterServiceRegistry,
    RouterServiceRegistry.of({
      list: Effect.succeed([]),
      select: () => Effect.die("Empty catalog must not select a router."),
    }),
  );
  const poisonGlobal = Layer.succeed(
    GlobalAppService,
    GlobalAppService.of({
      id: "global",
      root: Effect.die("No global root read."),
      paths: Effect.die("No global paths read."),
      providerId: Effect.die("No provider read."),
      ensureRoot: Effect.die("No root write."),
      ensureUserLandofile: Effect.die("No Landofile write."),
      ensureRunning: () => Effect.die("No startup."),
      regenerateDist: () => Effect.die("No generation."),
    }),
  );
  try {
    const router = await Effect.runPromise(
      RouterService.pipe(
        Effect.provide(
          layerSelected.pipe(Layer.provide(Layer.mergeAll(isolated.dependencies, poisonGlobal, noRouters))),
        ),
      ),
    );
    expect(router.id).toBe("unavailable");
    expect(await Bun.file(isolated.lockPath).exists()).toBe(false);
  } finally {
    await rm(isolated.root, { recursive: true, force: true });
  }
});
