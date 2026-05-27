/**
 * Provider conflict detection for `meta:doctor`.
 *
 * The single conflict the runtime currently knows how to diagnose is the
 * `@lando/provider-lando` ↔ `@lando/provider-podman` socket collision: when
 * `provider-lando` has been set up against a Podman socket that
 * `provider-podman` would also target, both providers race over the same
 * Podman API and the user must pick one explicitly.
 *
 * Detection re-uses `provider-podman`'s existing `detectProviderLandoConflict`
 * helper (which reads `<stateDir>/provider-lando/setup-state.json`) and
 * `resolvePodmanSocket` (which mirrors the user-installed Podman resolution
 * `provider-podman` would perform at construction time). The doctor command
 * runs the same detection eagerly so it can surface the typed
 * `ProviderLandoConflictError` (carrying its `lando setup --provider=…`
 * remediation) even when the user has not yet asked the runtime to construct
 * `provider-podman`.
 */
import { Effect } from "effect";

import {
  ProviderLandoConflictError,
  type ProviderLandoStateError,
  detectProviderLandoConflict,
  resolvePodmanSocket,
} from "@lando/provider-podman";
import type { HostPlatform } from "@lando/sdk/schema";

export interface DetectProviderConflictsOptions {
  /**
   * Root state directory passed to providers, typically
   * `<userDataRoot>/providers`. Conflict detection is skipped when this is
   * `undefined`.
   */
  readonly stateDir: string | undefined;
  /** Host platform; defaults to the current `process.platform`. */
  readonly platform?: HostPlatform;
  /**
   * Environment lookup used to resolve the Podman socket (mirrors what
   * `provider-podman` would do). Defaults to `process.env`.
   */
  readonly env?: Readonly<Record<string, string | undefined>>;
}

export interface ProviderConflictReport {
  readonly _tag: "ProviderLandoConflict";
  readonly providerId: string;
  readonly operation: string;
  readonly message: string;
  readonly remediation: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

const toReport = (error: ProviderLandoConflictError): ProviderConflictReport => ({
  _tag: "ProviderLandoConflict",
  providerId: error.providerId,
  operation: error.operation,
  message: error.message,
  remediation: error.remediation ?? "",
  ...(error.details === undefined || error.details === null
    ? {}
    : { details: error.details as Readonly<Record<string, unknown>> }),
});

/**
 * Detect provider-lando ↔ provider-podman socket conflicts.
 *
 * Returns an array of `ProviderConflictReport` objects. Empty array means
 * no conflict was detected (either provider-lando has not been set up, the
 * recorded socket does not match, or `stateDir` is unavailable).
 *
 * Underlying `ProviderLandoStateError` (malformed state file) is propagated
 * as a typed failure so callers can surface it explicitly.
 */
export const detectProviderConflicts = (
  options: DetectProviderConflictsOptions,
): Effect.Effect<ReadonlyArray<ProviderConflictReport>, ProviderLandoStateError> =>
  Effect.gen(function* () {
    const stateDir = options.stateDir;
    if (stateDir === undefined || stateDir.length === 0) return [] as const;

    const env = options.env ?? process.env;
    const socketPath = resolvePodmanSocket({
      env,
      ...(options.platform === undefined ? {} : { platform: options.platform }),
    });

    const result = yield* detectProviderLandoConflict(stateDir, socketPath).pipe(Effect.either);
    if (result._tag === "Right") return [] as const;
    const error = result.left;
    if (error instanceof ProviderLandoConflictError) {
      return [toReport(error)] as const;
    }
    return yield* Effect.fail(error);
  });
