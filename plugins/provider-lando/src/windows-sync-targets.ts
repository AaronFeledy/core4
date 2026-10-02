import { Effect } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { PluginStateStore } from "@lando/sdk/plugins";
import type { AppPlan, FileSyncSessionSpec } from "@lando/sdk/schema";

import { verifiedFileSyncSessions } from "./applied-file-sync.ts";
import {
  type WindowsSyncHelperEndpoint,
  type WindowsSyncHelperSpec,
  ensureWindowsSyncHelper,
} from "./windows-sync-helper.ts";

export interface WindowsSyncTargetOperations {
  readonly prepareImage: (image: string) => Effect.Effect<void, ProviderUnavailableError>;
  readonly ensure: (
    spec: WindowsSyncHelperSpec,
  ) => Effect.Effect<WindowsSyncHelperEndpoint, ProviderUnavailableError>;
}

/** Bind preparation to the provider's Podman API and durable plugin state. */
export const makeWindowsSyncTargetOperations = (
  api: Pick<PodmanApiClient, "request">,
  stateStore: PluginStateStore,
  prepareImage: WindowsSyncTargetOperations["prepareImage"],
): WindowsSyncTargetOperations => ({
  prepareImage,
  ensure: (spec) => ensureWindowsSyncHelper(api, stateStore, spec),
});

export interface PreparedWindowsSyncTargets {
  readonly targets: ReadonlyArray<{
    readonly session: FileSyncSessionSpec;
    readonly endpoint: WindowsSyncHelperEndpoint;
  }>;
}

const invalidPlan = (message: string) =>
  new ProviderUnavailableError({
    providerId: "lando",
    operation: "prepareFileSyncTargets",
    message,
    remediation:
      "Check the planned accelerated mounts and their complete file-sync coverage before retrying.",
  });

/**
 * Prepares the full target set and returns verified endpoints. Failed or
 * interrupted preparation deliberately retains helpers and volumes. Recorded
 * identities permit retry; creation interrupted before identity persistence
 * fails closed and may require manual remediation. Deleting without an exact
 * instance-conditional API could affect a concurrent user.
 */
export const prepareWindowsSyncTargets = (
  plan: AppPlan,
  image: string,
  helpers: WindowsSyncTargetOperations,
): Effect.Effect<PreparedWindowsSyncTargets, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const sessions = verifiedFileSyncSessions(plan);
    if (String(plan.provider) !== "lando" || sessions === undefined) {
      return yield* Effect.fail(
        invalidPlan("The accelerated mount plan has incomplete or invalid file-sync targets."),
      );
    }
    if (!/@sha256:[a-f0-9]{64}$/u.test(image)) {
      return yield* Effect.fail(invalidPlan("The sync helper image must use an immutable SHA-256 digest."));
    }

    yield* helpers.prepareImage(image);

    const targets = yield* Effect.forEach(sessions, (session) => {
      const spec: WindowsSyncHelperSpec = {
        appId: String(plan.id),
        appName: plan.name,
        service: String(session.service),
        mountKey: session.mountKey,
        image,
      };
      return helpers
        .ensure(spec)
        .pipe(
          Effect.flatMap((endpoint) =>
            session.target._tag === "volume" &&
            endpoint.volumeName === session.target.name &&
            endpoint.path === "/sync"
              ? Effect.succeed({ session, endpoint })
              : Effect.fail(invalidPlan("The prepared helper endpoint does not match its planned volume.")),
          ),
        );
    });
    return { targets };
  });
