import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import {
  recordGlobalResourceCleanup,
  recordGlobalRouteCleanup,
} from "@lando/engine/global-app/reconciliation";
import { Effect, Schema } from "effect";

import { GlobalDestroyConfirmationError } from "@lando/sdk/errors";

import {
  executeGlobalTeardown,
  globalTeardownAppRef,
  resolveGlobalTeardown,
} from "@lando/engine/operations/global-teardown";
import { TeardownProvider } from "@lando/engine/providers/app-placement";
import { DestroyAppOutcome, DestroyAppResult, type ProviderId } from "@lando/sdk/schema";
import { RouterService } from "@lando/sdk/services";
import { teardownLine, volumesTrailer } from "../service-summary";

export interface GlobalDestroyOptions {
  readonly providerId?: ProviderId;
  readonly yes?: boolean;
  readonly purge?: boolean;
}

export const GlobalDestroyResultSchema = Schema.Struct({
  app: DestroyAppResult.fields.app,
  outcome: DestroyAppOutcome,
  materialized: Schema.Boolean.annotate({
    description: "Whether the global app has a materialized Landofile.",
  }),
  servicesDestroyed: DestroyAppResult.fields.servicesDestroyed,
  volumesRemoved: DestroyAppResult.fields.volumesRemoved,
});

export type GlobalDestroyResult = typeof GlobalDestroyResultSchema.Type;

type GlobalDestroyError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | GlobalDestroyConfirmationError
  | import("@lando/sdk/errors").ProxyError
  | import("@lando/sdk/errors").GlobalAppError;

type GlobalDestroyServices =
  | GlobalMutationServices
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Services<ReturnType<typeof recordGlobalResourceCleanup>>;

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

  return yield* withGlobalMutation(
    Effect.gen(function* () {
      const loaded = yield* resolveGlobalTeardown().pipe(
        Effect.provideService(TeardownProvider, options.providerId),
      );
      const volumes = options.purge ?? false;
      if (loaded.evidence.kind === "absent") {
        if (options.providerId === undefined) {
          const router = yield* RouterService;
          yield* router.removeRoutes(globalTeardownAppRef(loaded).id);
          yield* recordGlobalRouteCleanup();
        }
        return {
          app: "global",
          outcome: "unchanged" as const,
          materialized: loaded.materialized,
          servicesDestroyed: [],
          volumesRemoved: false,
        };
      }

      const receipt = yield* executeGlobalTeardown(loaded, { intent: "destroy", volumes, removeState: true });
      if (options.providerId === undefined) yield* recordGlobalResourceCleanup();

      return {
        app: "global",
        outcome: receipt.changed ? ("destroyed" as const) : ("unchanged" as const),
        materialized: loaded.materialized,
        servicesDestroyed: receipt.services,
        volumesRemoved: receipt.volumesRemoved,
      };
    }),
  );
});
