import { expect, test } from "bun:test";
import { makeLandoPaths } from "@lando/paths";
import { ProxyApplyError, ProxyError, ProxySetupError } from "@lando/sdk/errors";
import { AppId, type AppRouteOwner, appIdentityKey } from "@lando/sdk/schema";
import { GlobalAppService, PathsService, RouterService, StateStore } from "@lando/sdk/services";
import { makeTestRouterService } from "@lando/sdk/test";
import { PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { Context, Effect, Layer, Result } from "effect";
import { CertificateAuthorityResolver } from "../../../src/plugins/certificate-authority-resolver.ts";
import * as BunFileSystem from "../../../src/services/file-system.ts";
import {
  layerUnavailableFor,
  makeUnavailableRouter,
  unavailableRouterReason,
} from "../../../src/subsystems/proxy/api.ts";
import {
  type RouterServiceRegistration,
  RouterServiceRegistry,
  layerSelected,
  makeRouterServiceRegistry,
} from "../../../src/subsystems/proxy/registry.ts";
import { makeTestStateStore } from "../../../src/testing/state-store.ts";

const reason = new ProxyError({
  message: "Router service missing is not installed.",
  proxyId: "missing",
  remediation: "Install a RouterService plugin or configure `defaultRouterService` to an installed id.",
});
const owner = { id: AppId.make("demo"), ownerKey: appIdentityKey("owner", "/apps/demo") };
const config = { defaultDomain: "lndo.site", router: {} };

test("an unavailable router fails route changes with its selection reason and keeps observation soft", async () => {
  // Given: a router built from a selection failure.
  // When: every member runs.
  const result = await Effect.runPromise(
    Effect.gen(function* () {
      const router = yield* RouterService;
      return {
        setup: yield* Effect.scoped(router.setup(config)).pipe(Effect.result),
        apply: yield* router.applyRoutes([], owner).pipe(Effect.result),
        remove: yield* router.removeRoutes(owner).pipe(Effect.result),
        status: yield* router.status,
        observed: yield* router.observeRoutes(owner, []),
        stop: yield* router.stop.pipe(Effect.result),
        revalidate: yield* router.revalidateStartup.pipe(Effect.result),
      };
    }).pipe(Effect.provide(layerUnavailableFor(reason))),
  );

  // Then: mutations carry the reason; observation reports nothing running and an unknown route state.
  const fields = { message: reason.message, proxyId: "missing", remediation: reason.remediation };
  expect(result).toEqual({
    setup: Result.fail(new ProxySetupError(fields)),
    apply: Result.fail(new ProxyApplyError({ ...fields, app: "demo" })),
    remove: Result.fail(new ProxyError(fields)),
    status: { state: "stopped", authorities: [], configuredApps: [] },
    observed: { configuredAuthorities: [], observation: { status: "unknown" } },
    stop: Result.succeed(undefined),
    revalidate: Result.succeed(undefined),
  });
});

test("the unavailable reason survives a wrapped router and is absent from a selected one", async () => {
  // Given: an unavailable router re-provided through a spreading wrapper, as router layers do.
  const wrapped = await Effect.runPromise(
    Effect.flatMap(RouterService, (router) => Effect.succeed(RouterService.of({ ...router }))).pipe(
      Effect.provide(Layer.succeed(RouterService, makeUnavailableRouter(reason))),
    ),
  );

  // Then: only the unavailable router reports a reason.
  expect(unavailableRouterReason(wrapped)).toBe(reason);
  expect(unavailableRouterReason(makeTestRouterService())).toBeUndefined();
});

test("an unavailable router given a withdrawal runs it for route removal and nothing else", async () => {
  // Given: a router built from a selection failure with installed routers to withdraw through.
  const withdrawn: AppRouteOwner[] = [];
  const router = makeUnavailableRouter(reason, (target) => Effect.sync(() => void withdrawn.push(target)));

  // When
  const result = await Effect.runPromise(
    Effect.all({
      remove: router.removeRoutes(owner).pipe(Effect.result),
      apply: router.applyRoutes([], owner).pipe(Effect.result),
    }),
  );

  // Then: removal is delegated; publication still fails and the reason stays detectable.
  expect(result.remove).toEqual(Result.succeed(undefined));
  expect(result.apply).toMatchObject({
    _tag: "Failure",
    failure: { _tag: "ProxyApplyError", proxyId: "missing" },
  });
  expect(withdrawn).toEqual([owner]);
  expect(unavailableRouterReason(RouterService.of({ ...router }))).toBe(reason);
});

/** Installed routers that record builds and withdrawals; selection names a router none of them is. */
const installedRouters = (
  routers: ReadonlyArray<{ readonly id: string; readonly build?: "fails"; readonly remove?: "fails" }>,
) => {
  const builds: string[] = [];
  const removals: string[] = [];
  const failure = (id: string) =>
    new ProxyError({ message: `${id} failed.`, proxyId: id, remediation: `Repair ${id}.` });
  const registrations: RouterServiceRegistration[] = routers.map(({ id, build, remove }) => ({
    id,
    layer: Layer.effect(
      RouterService,
      Effect.suspend(() => {
        builds.push(id);
        return build === "fails"
          ? Effect.fail(failure(id))
          : Effect.succeed(
              RouterService.of({
                ...makeTestRouterService(),
                id,
                removeRoutes: () =>
                  Effect.sync(() => void removals.push(id)).pipe(
                    Effect.andThen(remove === "fails" ? Effect.fail(failure(id)) : Effect.void),
                  ),
              }),
            );
      }),
    ),
  }));
  const paths = makeLandoPaths({ userDataRoot: "/tmp/unavailable-router-test", env: {} });
  const dependencies = Layer.mergeAll(
    Layer.succeed(
      RouterServiceRegistry,
      RouterServiceRegistry.of(
        makeRouterServiceRegistry({
          registrations,
          configured: Effect.succeed("missing"),
          platform: "linux",
        }),
      ),
    ),
    BunFileSystem.layer,
    Layer.succeed(PathsService, paths),
    Layer.succeed(StateStore, makeTestStateStore().service),
    Layer.succeed(
      PrivateFileAccessService,
      PrivateFileAccessService.of({ enforce: async () => undefined, verify: async () => undefined }),
    ),
    Layer.succeed(
      GlobalAppService,
      GlobalAppService.of({
        id: "global",
        root: Effect.die("Route withdrawal must not resolve the global root."),
        paths: Effect.die("Route withdrawal must not resolve global paths."),
        providerId: Effect.die("Route withdrawal must not resolve the global provider."),
        ensureRoot: Effect.die("Route withdrawal must not create a global root."),
        ensureUserLandofile: Effect.die("Route withdrawal must not create a Landofile."),
        ensureRunning: () => Effect.die("Route withdrawal must not start global services."),
        regenerateDist: () => Effect.die("Route withdrawal must not regenerate configuration."),
      }),
    ),
    Layer.succeed(
      CertificateAuthorityResolver,
      CertificateAuthorityResolver.of({
        resolve: Effect.die("Route withdrawal must not resolve a certificate authority."),
      }),
    ),
  );
  const run = (withdraw: boolean) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = Context.get(yield* Layer.build(layerSelected), RouterService);
          const state = (yield* router.status).state;
          const builtBeforeWithdrawal = [...builds];
          const removed = withdraw ? yield* Effect.result(router.removeRoutes(owner)) : undefined;
          return { state, builtBeforeWithdrawal, removed };
        }),
      ).pipe(Effect.provide(dependencies)),
    );
  return { builds, removals, run };
};

test("#2138 an unselectable router withdraws through every installed router, building them only then", async () => {
  // Given: two installed routers and a configured router that is neither.
  const installed = installedRouters([{ id: "alpha" }, { id: "beta" }]);

  // When
  const { state, builtBeforeWithdrawal, removed } = await installed.run(true);

  // Then: bootstrap and status built nothing; withdrawal built and reached both routers.
  expect(state).toBe("stopped");
  expect(builtBeforeWithdrawal).toEqual([]);
  expect(removed).toEqual(Result.succeed(undefined));
  expect(installed.builds).toEqual(["alpha", "beta"]);
  expect(installed.removals).toEqual(["alpha", "beta"]);
});

test.each([
  { name: "fails to withdraw", alpha: { id: "alpha", remove: "fails" as const } },
  { name: "fails to build", alpha: { id: "alpha", build: "fails" as const } },
])(
  "#2138 an installed router that $name fails the withdrawal after the others were attempted",
  async ({ alpha }) => {
    // Given: one installed router that cannot withdraw and one that can.
    const installed = installedRouters([alpha, { id: "beta" }]);

    // When
    const { builtBeforeWithdrawal, removed } = await installed.run(true);

    // Then: the failure names the broken router, and the healthy router still withdrew.
    expect(builtBeforeWithdrawal).toEqual([]);
    expect(removed).toMatchObject({ _tag: "Failure", failure: { _tag: "ProxyError", proxyId: "alpha" } });
    expect(installed.removals).toContain("beta");
  },
);

test("#2138 an installed router that fails to build cannot fail bootstrap or status", async () => {
  // Given: the only installed router is broken and is not the configured one.
  const installed = installedRouters([{ id: "alpha", build: "fails" }]);

  // When: the runtime router is built and observed without withdrawing anything.
  const { state, removed } = await installed.run(false);

  // Then
  expect({ state, removed, builds: installed.builds }).toEqual({
    state: "stopped",
    removed: undefined,
    builds: [],
  });
});
