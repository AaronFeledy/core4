import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { withPreservedPathVerdict } from "@lando/container-runtime/capabilities";
import type { ProviderCapabilities } from "@lando/sdk/schema";
import { Effect } from "effect";

import { readRuntimePid } from "./linux-runtime-reaper.ts";
import type { PodmanServiceRunner, PodmanServiceSpec } from "./podman-service-runner.ts";
import { RUNTIME_BUNDLE_MANIFEST } from "./runtime-bundle.ts";
import { readLaunchState } from "./runtime-launch-state.ts";

/** First managed Linux runtime whose Podman schedules healthchecks inside its API service. */
export const NATIVE_HEALTH_RUNTIME_VERSION = "0.1.9" as const;

/** True for a runtime version that ships the in-service healthcheck scheduler. */
export const runtimeSchedulesNativeHealth = (version: string | undefined): boolean =>
  version !== undefined && Bun.semver.satisfies(version, `>=${NATIVE_HEALTH_RUNTIME_VERSION}`);

/**
 * The scheduling service writes its PID and a newline here once its startup sweep armed every
 * running container, and removes it when it stops scheduling.
 */
const schedulerAckPath = (runRoot: string): string => join(runRoot, "healthcheck-scheduler.pid");

const readSchedulerAck = (runRoot: string): Effect.Effect<number | undefined> =>
  Effect.promise(() =>
    readFile(schedulerAckPath(runRoot), "utf8").then(
      (content) => (/^[1-9]\d*\n$/u.test(content) ? Number(content.trim()) : undefined),
      () => undefined,
    ),
  );

/** Who schedules native healthchecks on the managed Linux runtime, and the fix when nothing does. */
export type NativeHealthScheduling =
  /**
   * `service`: the running service acknowledged its scheduler; `next-launch`: no service that opted
   * in runs yet, and the next one ensure launches does. `unacknowledged`: a launch opted in but its
   * service never acknowledged a scheduler.
   */
  | { readonly scheduled: true; readonly by: "service" | "next-launch" }
  | {
      readonly scheduled: false;
      readonly reason: "runtime-outdated" | "unacknowledged";
      readonly remediation: string;
    };

/** The step that installs a scheduling runtime, or the honest answer that this build has none. */
export const outdatedRuntimeRemediation = (
  pinnedVersion: string = RUNTIME_BUNDLE_MANIFEST.runtimeVersion,
): string =>
  runtimeSchedulesNativeHealth(pinnedVersion)
    ? `Run \`lando setup\` to update the Lando runtime to ${pinnedVersion}, which schedules native healthchecks.`
    : `Native healthcheck scheduling needs Lando runtime ${NATIVE_HEALTH_RUNTIME_VERSION} or newer, which is not available in this Lando build (it installs runtime ${pinnedVersion}).`;

const unacknowledgedSchedulerRemediation =
  "Run `lando poweroff`, then rerun the command: the runtime service relaunches with native healthcheck scheduling.";

const outdated = (pinnedVersion?: string): NativeHealthScheduling => ({
  scheduled: false,
  reason: "runtime-outdated",
  remediation: outdatedRuntimeRemediation(pinnedVersion),
});

const nextLaunch: NativeHealthScheduling = { scheduled: true, by: "next-launch" };

/** What the next `lando setup` installs decides the offline declaration, as for `deploy.resources`. */
export const offlineNativeHealthScheduling = (
  pinnedVersion: string = RUNTIME_BUNDLE_MANIFEST.runtimeVersion,
): NativeHealthScheduling =>
  runtimeSchedulesNativeHealth(pinnedVersion) ? nextLaunch : outdated(pinnedVersion);

interface SchedulerAckPaths {
  readonly runRoot: string;
  readonly pidPath: string;
}

type SchedulerProcesses = Pick<PodmanServiceRunner, "isDescendant">;

/** True when the scheduler's acknowledgement names `pid` or, for rootless Podman, its re-executed child. */
const schedulerAcknowledged = Effect.fnUntraced(function* (
  runRoot: string,
  pid: number,
  processes: SchedulerProcesses,
): Effect.fn.Return<boolean> {
  const ack = yield* readSchedulerAck(runRoot);
  if (ack === undefined) return false;
  return ack === pid || (yield* processes.isDescendant?.(ack, pid) ?? Effect.succeed(undefined)) === true;
});

/** The launch record of `pid` names a scheduling runtime, so that launch opted in to scheduling. */
const launchOptedIn = Effect.fnUntraced(function* (pidPath: string, pid: number): Effect.fn.Return<boolean> {
  const record = yield* readLaunchState(pidPath);
  return record?.pid === pid && runtimeSchedulesNativeHealth(record.runtimeBundleVersion);
});

/**
 * Whether the service launched as `pid` schedules checks: its launch record names a scheduling
 * runtime and the scheduler's acknowledgement names that service. Rootless Podman serves from a
 * child it re-executes into its user namespace, so the acknowledgement may name that descendant.
 */
export const serviceSchedulesNativeHealth = Effect.fnUntraced(function* (
  paths: SchedulerAckPaths,
  pid: number,
  processes: SchedulerProcesses,
): Effect.fn.Return<boolean> {
  return (
    (yield* launchOptedIn(paths.pidPath, pid)) &&
    (yield* schedulerAcknowledged(paths.runRoot, pid, processes))
  );
});

export interface ManagedNativeHealthDeps extends SchedulerAckPaths {
  readonly installedVersion: string | undefined;
  readonly spec: PodmanServiceSpec;
  readonly serviceRunner: Pick<PodmanServiceRunner, "isAlive" | "isServiceProcess" | "isDescendant">;
}

/**
 * Live scheduling for the managed Linux runtime. The installed runtime must ship the scheduler.
 * With no owned service running, or one whose launch record names an older runtime, the next
 * launch opts in: ensure relaunches a service whose recorded launch differs from the one it would
 * start. A service that opted in counts only when its acknowledgement names that service.
 */
export const managedNativeHealthScheduling = Effect.fnUntraced(function* (
  deps: ManagedNativeHealthDeps,
): Effect.fn.Return<NativeHealthScheduling> {
  if (!runtimeSchedulesNativeHealth(deps.installedVersion)) return outdated();
  const pid = yield* readRuntimePid(deps.pidPath);
  if (pid === undefined || !(yield* deps.serviceRunner.isAlive(pid))) return nextLaunch;
  if (!(yield* deps.serviceRunner.isServiceProcess?.(pid, deps.spec) ?? Effect.succeed(false)))
    return nextLaunch;
  if (!(yield* launchOptedIn(deps.pidPath, pid))) return nextLaunch;
  return (yield* schedulerAcknowledged(deps.runRoot, pid, deps.serviceRunner))
    ? { scheduled: true, by: "service" }
    : { scheduled: false, reason: "unacknowledged", remediation: unacknowledgedSchedulerRemediation };
});

/**
 * Applies scheduling to the managed Linux declaration. The runtime that schedules checks also
 * realizes `healthcheck.start_interval`; without it the key is withheld with the step that fixes it.
 */
export const withNativeHealth = (
  capabilities: ProviderCapabilities,
  scheduling: NativeHealthScheduling,
): ProviderCapabilities =>
  withPreservedPathVerdict(
    { ...capabilities, serviceHealth: scheduling.scheduled ? "native" : "none" },
    "healthcheck.start_interval",
    scheduling.scheduled ? { _tag: "supported" } : { _tag: "withheld", remediation: scheduling.remediation },
  );
