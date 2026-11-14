import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import {
  recordGlobalResourceCleanup,
  recordGlobalRouteCleanup,
} from "@lando/engine/global-app/reconciliation";
import { executeGlobalTeardown, resolveGlobalTeardown } from "@lando/engine/operations/global-teardown";
import { TeardownProvider } from "@lando/engine/providers/app-placement";
import { GlobalDestroyConfirmationError } from "@lando/sdk/errors";
import { DestroyAppOutcome, DestroyAppResult, type ProviderId } from "@lando/sdk/schema";
import { PathsService, StateStore } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { GLOBAL_APP_ID } from "../global-app/service.ts";
import { routeOwnerFromGlobalTeardown } from "../lifecycle/route-owner.ts";
import { type RouteWithdrawal, withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import { removeServiceCertificates } from "../lifecycle/service-certificate-paths.ts";
import { clearAppBuildResults } from "../services/build-results.ts";
import { removeBuildTranscripts } from "../services/build-transcript-cleanup.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";

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
  shutdownObservations: DestroyAppResult.fields.shutdownObservations,
});

export type GlobalDestroyResult = typeof GlobalDestroyResultSchema.Type;

export type GlobalDestroyError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | GlobalDestroyConfirmationError
  | import("@lando/sdk/errors").ProxyError
  | import("@lando/sdk/errors").GlobalAppError;

export type GlobalDestroyServices =
  | GlobalMutationServices
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Services<ReturnType<typeof recordGlobalResourceCleanup>>;

const confirmationError = (): GlobalDestroyConfirmationError =>
  new GlobalDestroyConfirmationError({
    message: "Destroying the global Lando app requires confirmation.",
    remediation: "Re-run with --yes to confirm.",
  });

export const globalDestroy = Effect.fn("GlobalDestroy.destroy")(function* (
  options: GlobalDestroyOptions = {},
): Effect.fn.Return<GlobalDestroyResult, GlobalDestroyError, GlobalDestroyServices> {
  if (options.yes !== true) return yield* Effect.fail(confirmationError());

  return yield* withGlobalMutation(
    Effect.gen(function* () {
      const stateStore = yield* StateStore;
      const paths = yield* PathsService;
      const providerId = String(options.providerId ?? "lando");
      const removeBuildOutput = clearAppBuildResults(stateStore, GLOBAL_APP_ID).pipe(
        Effect.andThen(
          removeBuildTranscripts({
            providerId,
            userDataRoot: paths.roots.userDataRoot,
            appId: GLOBAL_APP_ID,
            scratch: false,
          }),
        ),
      );
      const loaded = yield* resolveGlobalTeardown("destroy").pipe(
        Effect.provideService(TeardownProvider, options.providerId),
      );
      const volumes = options.purge ?? false;
      if (loaded.evidence.kind === "absent") {
        if (options.providerId === undefined) {
          const withdrawal = yield* withdrawOwnerRoutes(routeOwnerFromGlobalTeardown(loaded));
          // A skipped withdrawal proves nothing, so route obligations stay pending.
          if (withdrawal.kind === "withdrawn") yield* recordGlobalRouteCleanup();
          // A start that failed after certificate preparation leaves only host-side leaf material.
          yield* removeServiceCertificates(routeOwnerFromGlobalTeardown(loaded).ownerKey);
        }
        yield* removeBuildOutput;
        return {
          app: "global",
          outcome: "unchanged" as const,
          materialized: loaded.materialized,
          servicesDestroyed: [],
          volumesRemoved: false,
        };
      }

      const receipt: Effect.Success<ReturnType<typeof executeGlobalTeardown>> & {
        readonly routes?: RouteWithdrawal["kind"];
      } = yield* executeGlobalTeardown(loaded, { intent: "destroy", volumes, removeState: true });
      yield* removeBuildOutput;
      // Cleanup proof covers routes, so a skipped withdrawal leaves every obligation pending.
      if (options.providerId === undefined && receipt.routes === "withdrawn")
        yield* recordGlobalResourceCleanup();
      // A provider-scoped destroy keeps leaf material another provider's realization may mount.
      if (options.providerId === undefined)
        yield* removeServiceCertificates(routeOwnerFromGlobalTeardown(loaded).ownerKey);

      return withShutdownObservations(
        {
          app: "global",
          outcome: receipt.changed ? ("destroyed" as const) : ("unchanged" as const),
          materialized: loaded.materialized,
          servicesDestroyed: receipt.services,
          volumesRemoved: receipt.volumesRemoved,
        },
        receipt.shutdownObservations,
      );
    }),
  );
});
