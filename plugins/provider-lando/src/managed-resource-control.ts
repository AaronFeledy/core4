import { Effect } from "effect";

import type { PodmanApiClient } from "@lando/container-runtime/engine-api";
import type { HostPlatform } from "@lando/sdk/schema";

import { type ResourceControl, linuxResourceControl } from "./capabilities.ts";
import { type DelegatedScopeHost, runningSharedServiceRemediation } from "./delegated-scope.ts";
import { countRunningContainers } from "./linux-runtime-health.ts";
import { readRuntimePid } from "./linux-runtime-reaper.ts";
import type { PodmanServiceRunner, PodmanServiceSpec } from "./podman-service-runner.ts";
import { recordedContainerCgroups } from "./runtime-launch-state.ts";

export interface ManagedResourceControlDeps {
  readonly platform: HostPlatform;
  readonly host: DelegatedScopeHost;
  readonly pidPath: string;
  readonly spec: PodmanServiceSpec;
  readonly serviceRunner: PodmanServiceRunner;
  readonly podmanApi: PodmanApiClient;
}

/**
 * Live resource control for the managed Linux service. A running owned service answers from the
 * placement observed at its launch; a service that predates delegation counts as delegated only
 * when the next ensure will relaunch it (eligible host, no running containers). With no service
 * running, the next launch decides.
 */
export const managedResourceControl = Effect.fnUntraced(function* (
  deps: ManagedResourceControlDeps,
): Effect.fn.Return<ResourceControl> {
  const next = linuxResourceControl(deps.platform, deps.host);
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid === undefined || !(yield* deps.serviceRunner.isAlive(pid))) return next;
  if (!(yield* deps.serviceRunner.isServiceProcess?.(pid, deps.spec) ?? Effect.succeed(false))) return next;
  if ((yield* recordedContainerCgroups(deps.pidPath, pid)) === "delegated") return { declared: true };
  if (!next.declared) return next;
  return (yield* countRunningContainers(deps.podmanApi)) === 0
    ? next
    : { declared: false, remediation: runningSharedServiceRemediation };
});
