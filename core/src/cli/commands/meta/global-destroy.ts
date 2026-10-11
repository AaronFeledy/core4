import { Effect, Schema } from "effect";

import { GlobalDestroyConfirmationError, type ProxyError } from "@lando/sdk/errors";

import { RouterService } from "@lando/sdk/services";

import {
  executeGlobalTeardown,
  globalTeardownAppRef,
  resolveGlobalTeardown,
} from "@lando/engine/operations/global-teardown";
import { teardownLine, volumesTrailer } from "../service-summary";

export interface GlobalDestroyOptions {
  readonly yes?: boolean;
  readonly purge?: boolean;
}

export const GlobalDestroyResultSchema = Schema.Struct({
  app: Schema.String,
  outcome: Schema.Literals(["destroyed", "unchanged"]),
  materialized: Schema.Boolean,
  servicesDestroyed: Schema.Array(Schema.String),
  volumesRemoved: Schema.Boolean,
});

export type GlobalDestroyResult = typeof GlobalDestroyResultSchema.Type;

type GlobalDestroyError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | GlobalDestroyConfirmationError
  | ProxyError;

type GlobalDestroyServices =
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | RouterService;

const confirmationError = (): GlobalDestroyConfirmationError =>
  new GlobalDestroyConfirmationError({
    message: "Destroying the global Lando app requires confirmation.",
    remediation: "Re-run with --yes to confirm.",
  });

export const renderGlobalDestroyResult = (result: GlobalDestroyResult): string => {
  return teardownLine(
    result.outcome,
    result.app,
    result.servicesDestroyed,
    volumesTrailer(result.volumesRemoved),
  );
};

export const globalDestroy = Effect.fn("GlobalDestroy.destroy")(function* (
  options: GlobalDestroyOptions = {},
): Effect.fn.Return<GlobalDestroyResult, GlobalDestroyError, GlobalDestroyServices> {
  if (options.yes !== true) return yield* Effect.fail(confirmationError());

  const loaded = yield* resolveGlobalTeardown();
  const volumes = options.purge ?? false;
  if (loaded.evidence.kind === "absent") {
    return {
      app: "global",
      outcome: "unchanged",
      materialized: loaded.materialized,
      servicesDestroyed: [],
      volumesRemoved: false,
    };
  }

  const receipt = yield* executeGlobalTeardown(loaded, { volumes, removeState: true });
  const router = yield* RouterService;
  yield* router.removeRoutes(globalTeardownAppRef(loaded).id);

  return {
    app: "global",
    outcome: receipt.changed ? "destroyed" : "unchanged",
    materialized: loaded.materialized,
    servicesDestroyed: receipt.services,
    volumesRemoved: receipt.volumesRemoved,
  };
});
