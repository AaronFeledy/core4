// Resolves the live Podman socket that provider/service integration suites use
// when exercising the default Lando-managed runtime.
//
// Production resolution is owned by `core/src/providers/registry.ts`
// (PathsService-injected `providerSocketPath`); this helper mirrors that
// precedence for tests so the live suites no longer hard-depend on the
// `LANDO_TEST_PODMAN_SOCKET` environment variable. Precedence:
//
//   1. `LANDO_TEST_PODMAN_SOCKET` — documented local/CI rehearsal override.
//   2. The Lando-managed socket at `makeLandoPaths().providerSocketPath`,
//      brought up by `lando setup` / `ensureRuntime`.
//
// A candidate is only returned when the path is an existing socket on disk, so
// suites self-skip cleanly when no runtime has been provisioned.

import { statSync } from "node:fs";

import { makeLandoPaths } from "../config/paths.ts";

export const LANDO_TEST_PODMAN_SOCKET_ENV = "LANDO_TEST_PODMAN_SOCKET";

export type LiveProviderSocketSource = "env" | "paths";

export interface LiveProviderSocket {
  readonly socketPath: string;
  readonly source: LiveProviderSocketSource;
}

const isSocketOnDisk = (path: string): boolean => {
  try {
    return statSync(path).isSocket();
  } catch {
    return false;
  }
};

/**
 * Resolves the live provider socket from the rehearsal override or the
 * Lando-managed Paths default, requiring the candidate to exist on disk as a
 * socket. Returns `undefined` when neither candidate is a live socket.
 */
export const resolveLiveProviderSocket = (): LiveProviderSocket | undefined => {
  const override = process.env[LANDO_TEST_PODMAN_SOCKET_ENV];
  if (override !== undefined && override.length > 0 && isSocketOnDisk(override)) {
    return { socketPath: override, source: "env" };
  }

  const managedSocketPath = makeLandoPaths().providerSocketPath;
  if (isSocketOnDisk(managedSocketPath)) {
    return { socketPath: managedSocketPath, source: "paths" };
  }

  return undefined;
};

/** Convenience predicate for `test.skipIf(!hasLiveProviderSocket())` gates. */
export const hasLiveProviderSocket = (): boolean => resolveLiveProviderSocket() !== undefined;
