import { Effect, Ref, Semaphore } from "effect";

import { ProxyApplyError, type ProxyError, ProxySetupError } from "@lando/sdk/errors";
import { RouterService, type RouterServiceShape } from "@lando/sdk/services";

/** Keep provider bootstrap independent of global storage until routing is used. */
export const deferredRouter = Effect.fnUntraced(function* (
  identity: Pick<RouterServiceShape, "id" | "capabilities">,
  construct: Effect.Effect<RouterServiceShape, ProxyError>,
) {
  const current = yield* Ref.make<RouterServiceShape | undefined>(undefined);
  const construction = yield* Semaphore.make(1);
  const resolve = construction.withPermits(1)(
    Effect.gen(function* () {
      const cached = yield* Ref.get(current);
      if (cached !== undefined) return cached;
      const router = yield* construct;
      yield* Ref.set(current, router);
      return router;
    }),
  );
  const forSetup = resolve.pipe(
    Effect.mapError(
      (cause) =>
        new ProxySetupError({
          proxyId: identity.id,
          message: cause.message,
          remediation: cause.remediation,
          cause,
        }),
    ),
  );
  return RouterService.of({
    ...identity,
    prepare: (config) => Effect.flatMap(forSetup, (router) => router.prepare?.(config) ?? Effect.void),
    setup: (config, options) => Effect.flatMap(forSetup, (router) => router.setup(config, options)),
    revalidateStartup: Effect.flatMap(resolve, (router) => router.revalidateStartup),
    applyRoutes: (routes, app) =>
      resolve.pipe(
        Effect.mapError(
          (cause) =>
            new ProxyApplyError({
              proxyId: identity.id,
              app: String(app),
              message: cause.message,
              remediation: cause.remediation,
              cause,
            }),
        ),
        Effect.flatMap((router) => router.applyRoutes(routes, app)),
      ),
    removeRoutes: (app) => Effect.flatMap(resolve, (router) => router.removeRoutes(app)),
    observeRoutes: (app, requested) =>
      Effect.flatMap(resolve, (router) => router.observeRoutes(app, requested)),
    status: Effect.flatMap(resolve, (router) => router.status),
    stop: Effect.flatMap(resolve, (router) => router.stop),
  });
});
