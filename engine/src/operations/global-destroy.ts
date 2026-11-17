import { type GlobalMutationServices, withGlobalMutation } from "@lando/engine/global-app/mutation";
import {
  recordGlobalResourceCleanup,
  recordGlobalRouteCleanup,
} from "@lando/engine/global-app/reconciliation";
import { executeGlobalTeardown, resolveGlobalTeardown } from "@lando/engine/operations/global-teardown";
import { TeardownProvider } from "@lando/engine/providers/app-placement";
import { DestroyAppOutcome, DestroyAppResult, type ProviderId } from "@lando/sdk/schema";
import { Effect, Schema } from "effect";
import { routeOwnerFromGlobalTeardown } from "../lifecycle/route-owner.ts";
import { type RouteWithdrawal, withdrawOwnerRoutes } from "../lifecycle/route-withdrawal.ts";
import { removeServiceCertificates } from "../lifecycle/service-certificate-paths.ts";
import { BuildOwner } from "../services/build-owner.ts";
import { removeAppBuildOutput } from "../services/build-transcript-cleanup.ts";
import { withShutdownObservations } from "./shutdown-observations.ts";

export interface GlobalDestroyOptions {
  readonly providerId?: ProviderId;
  /** Remove global service- and app-scoped data volumes; built images are released. */
  readonly volumes?: boolean;
  /** Remove global service- and app-scoped data volumes and built images. */
  readonly purge?: boolean;
}

export const GlobalDestroyResultSchema = Schema.Struct({
  app: DestroyAppResult.fields.app,
  outcome: DestroyAppOutcome,
  materialized: Schema.Boolean.annotate({
    description: "Whether the global app has a materialized Landofile.",
  }),
  servicesDestroyed: DestroyAppResult.fields.servicesDestroyed,
  dataVolumesRemoved: DestroyAppResult.fields.dataVolumesRemoved,
  cacheVolumesRemoved: DestroyAppResult.fields.cacheVolumesRemoved,
  shutdownObservations: DestroyAppResult.fields.shutdownObservations,
  builtImages: DestroyAppResult.fields.builtImages,
});

export type GlobalDestroyResult = typeof GlobalDestroyResultSchema.Type;

export type GlobalDestroyError =
  | Effect.Error<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Error<ReturnType<typeof executeGlobalTeardown>>
  | import("@lando/sdk/errors").ProxyError
  | import("@lando/sdk/errors").GlobalAppError;

export type GlobalDestroyServices =
  | GlobalMutationServices
  | Effect.Services<ReturnType<typeof resolveGlobalTeardown>>
  | Effect.Services<ReturnType<typeof executeGlobalTeardown>>
  | Effect.Services<ReturnType<typeof recordGlobalResourceCleanup>>;

export const globalDestroy = Effect.fn("GlobalDestroy.destroy")(function* (
  options: GlobalDestroyOptions = {},
): Effect.fn.Return<GlobalDestroyResult, GlobalDestroyError, GlobalDestroyServices> {
  return yield* withGlobalMutation(
    Effect.gen(function* () {
      const loaded = yield* resolveGlobalTeardown("destroy").pipe(
        Effect.provideService(TeardownProvider, options.providerId),
      );
      const owner =
        loaded.evidence.kind === "applied"
          ? BuildOwner.fromPlan(loaded.evidence.plan)
          : BuildOwner.root(loaded.paths.root);
      const providerId = String(loaded.provider.id);
      const removeBuildOutput = removeAppBuildOutput(owner, providerId, options.providerId, {
        images: options.purge === true ? "remove" : "release",
      });
      const volumes = options.purge === true || options.volumes === true;
      if (loaded.evidence.kind === "absent") {
        if (options.providerId === undefined) {
          const withdrawal = yield* withdrawOwnerRoutes(routeOwnerFromGlobalTeardown(loaded));
          // A skipped withdrawal proves nothing, so route obligations stay pending.
          if (withdrawal.kind === "withdrawn") yield* recordGlobalRouteCleanup();
          // A start that failed after certificate preparation leaves only host-side leaf material.
          yield* removeServiceCertificates(routeOwnerFromGlobalTeardown(loaded).ownerKey);
        }
        const builtImages = yield* removeBuildOutput;
        return {
          app: "global",
          outcome: "unchanged" as const,
          materialized: loaded.materialized,
          servicesDestroyed: [],
          dataVolumesRemoved: false,
          cacheVolumesRemoved: false,
          builtImages,
        };
      }

      const receipt: Effect.Success<ReturnType<typeof executeGlobalTeardown>> & {
        readonly routes?: RouteWithdrawal["kind"];
      } = yield* executeGlobalTeardown(loaded, {
        intent: "destroy",
        volumes,
        removeState: true,
        purge: options.purge === true,
      });
      const builtImages = yield* removeBuildOutput;
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
          dataVolumesRemoved: receipt.volumesRemoved.data > 0,
          cacheVolumesRemoved: receipt.volumesRemoved.cache > 0,
          builtImages,
        },
        receipt.shutdownObservations,
      );
    }),
  );
});
