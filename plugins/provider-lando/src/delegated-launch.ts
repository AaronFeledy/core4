import type { PodmanApiClient } from "@lando/container-runtime/engine-api";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { type DelegatedScopeHost, observeServicePlacement, processCgroupPath } from "./delegated-scope.ts";
import { countRunningContainers } from "./linux-runtime-health.ts";
import { readRuntimePid } from "./linux-runtime-reaper.ts";
import type { PodmanServiceRunner, PodmanServiceScope } from "./podman-service-runner.ts";
import { recordServicePlacement, recordedContainerCgroups } from "./runtime-launch-state.ts";

interface PlacementDeps {
  readonly pidPath: string;
  readonly serviceRunner: Pick<PodmanServiceRunner, "terminate">;
}

/** A just-launched service and the scope its launch selected, if any. */
export interface LaunchedService {
  readonly host: DelegatedScopeHost;
  readonly pid: number;
  readonly scope: PodmanServiceScope | undefined;
}

/**
 * Records where the ready service runs. A launch that selected the delegated scope but did not end
 * up in a user-owned cgroup with memory, pids and cpu is stopped and fails: containers would
 * silently run without limits.
 */
export const verifyServicePlacement = Effect.fnUntraced(function* (
  deps: PlacementDeps,
  { host, pid, scope }: LaunchedService,
): Effect.fn.Return<void, ProviderUnavailableError> {
  const placement = observeServicePlacement(pid, host);
  if (scope !== undefined && placement !== "delegated") {
    yield* deps.serviceRunner.terminate(pid);
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "setup",
        message:
          "The Lando runtime service did not start in a delegated systemd user scope, so containers would not get their own cgroups.",
        remediation:
          "Run `lando doctor` to inspect the runtime placement and your systemd user manager, then rerun the command.",
        details: { pid, cgroup: processCgroupPath(pid, host) ?? "unknown", systemdRun: scope.systemdRun },
      }),
    );
  }
  yield* recordServicePlacement(deps.pidPath, pid, placement);
});

/**
 * A healthy service launched without delegation is replaced by a delegated one when the host now
 * allows it, but only while it runs no containers: stopping it keeps the private runtime dir,
 * pause process and namespaces, and no workload is interrupted.
 */
export const needsDelegatedRelaunch = Effect.fnUntraced(function* (
  deps: { readonly pidPath: string; readonly podmanApi: PodmanApiClient },
  scope: PodmanServiceScope | undefined,
): Effect.fn.Return<boolean> {
  if (scope === undefined) return false;
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid === undefined || (yield* recordedContainerCgroups(deps.pidPath, pid)) === "delegated") return false;
  return (yield* countRunningContainers(deps.podmanApi)) === 0;
});
