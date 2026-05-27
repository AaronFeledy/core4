/**
 * Provider conflict detection.
 *
 * Detects when `@lando/provider-lando` and `@lando/provider-podman` target
 * the same Podman socket, which would make both providers control the same
 * Podman API.
 *
 * Detection reuses provider-podman's setup-state and socket resolution helpers
 * so callers report the same typed conflict users would hit at runtime.
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
  readonly stateDir: string | undefined;
  readonly platform?: HostPlatform;
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
 * Malformed provider-lando state propagates as `ProviderLandoStateError`.
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
