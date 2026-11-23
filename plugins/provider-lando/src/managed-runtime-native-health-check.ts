import { readdirSync } from "node:fs";
import { dirname } from "node:path";
import { makePodmanApiClient } from "@lando/container-runtime/podman/api-client";
import {
  managedHealthUnitName,
  managedHealthUnitPrefix,
} from "@lando/container-runtime/podman/managed-health-units";
import { managedRuntimeDirForTeardown } from "@lando/container-runtime/podman/managed-runtime-dir";
import { runtimeLayoutPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { hostPlatformFamily } from "@lando/sdk/schema";
import { Effect } from "effect";

import {
  type DelegatedScopeHost,
  delegatedLaunchEligibility,
  delegatedScopeRemediation,
  systemDelegatedScopeHost,
  userSystemdTools,
} from "./delegated-scope.ts";
import { observeRunningService } from "./managed-runtime-cgroup-check.ts";
import type { HealthRun } from "./native-health-plan.ts";
import { ownedHealthRuns } from "./native-health-timers.ts";
import { providerContextForEnv } from "./provider-context.ts";

const CHECK = "managed-runtime-native-health";

/** Healthchecks of the runtime's owned running containers, or undefined when unreadable. */
export type OwnedHealthRuns = (input: {
  readonly socketPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly dataRoot: string;
}) => Effect.Effect<ReadonlyArray<HealthRun> | undefined>;

const ownedHealthRunsOverSocket: OwnedHealthRuns = (input) =>
  ownedHealthRuns(
    makePodmanApiClient(input.socketPath, providerContextForEnv(input.env)),
    input.dataRoot,
  ).pipe(
    Effect.timeout("5 seconds"),
    Effect.catch(() => Effect.succeed(undefined)),
  );

/** Unit files the user manager keeps for loaded transient units; a timer that stopped is gone. */
const transientUnitFiles = (userRuntimeDir: string): ReadonlyArray<string> | undefined => {
  try {
    return readdirSync(`${userRuntimeDir}/systemd/transient`);
  } catch {
    return undefined;
  }
};

export interface ManagedRuntimeNativeHealthCheckSeams {
  readonly host?: DelegatedScopeHost;
  readonly healthRuns?: OwnedHealthRuns;
  readonly transientUnits?: (userRuntimeDir: string) => ReadonlyArray<string> | undefined;
  readonly privateRuntimeDir?: (runtimeDir: string) => Effect.Effect<string | undefined>;
}

const unscheduled =
  "native healthchecks are not scheduled, so `lando info` reports their health as unknown and a healthcheck start interval is refused";

const report = (
  input: Pick<PluginDoctorReport, "status" | "runtimeStatus" | "context"> & {
    readonly running: boolean;
    readonly solution?: string;
  },
): PluginDoctorReport => ({
  name: CHECK,
  status: input.status,
  severity: input.status === "pass" ? "info" : "warn",
  ...(input.runtimeStatus === undefined ? {} : { runtimeStatus: input.runtimeStatus }),
  runtime: { running: input.running },
  context: input.context,
  solutions: input.solution === undefined ? [] : [{ kind: "manual", description: input.solution }],
});

/**
 * Whether Lando schedules native healthchecks on the managed Linux runtime. The runtime service
 * runs Podman off the user's bus, so its own timers never run; Lando creates systemd user timers
 * bound to the service's delegated scope. This needs a reachable user manager and a delegated
 * service, and for a running service every owned healthchecked container needs a timer.
 */
export const makeManagedRuntimeNativeHealthCheck = (
  seams: ManagedRuntimeNativeHealthCheckSeams = {},
): PluginDoctorCheckContribution => ({
  id: CHECK,
  run: Effect.fn("ManagedRuntimeNativeHealthCheck.run")(function* (input) {
    if (input.providerId !== "lando" || hostPlatformFamily(input.platform) !== "linux") return [];
    if (input.userDataRoot === undefined) return [];
    const host = seams.host ?? systemDelegatedScopeHost;
    const layout = runtimeLayoutPaths(input.userDataRoot, "linux");
    const service = yield* observeRunningService(layout.providerPidPath, host);
    const running = service !== undefined;
    const tools = userSystemdTools(input.platform, host);
    if (typeof tools === "string") {
      return [
        report({
          status: "warn",
          running,
          runtimeStatus: `Lando cannot reach your systemd user manager, so ${unscheduled}.`,
          context: { scheduler: "none", reason: tools },
          solution:
            tools === "missing-tools"
              ? "Lando schedules native healthchecks with the host's systemd-run and systemctl; install systemd, then start your apps again."
              : "Lando schedules native healthchecks with systemd user timers, and no systemd user manager runs for your user. Enable one with `loginctl enable-linger $USER` (or log in through a systemd session), then start your apps again.",
        }),
      ];
    }

    if (service === undefined) {
      const eligibility = delegatedLaunchEligibility(input.platform, host);
      return [
        eligibility.eligible
          ? report({
              status: "pass",
              running: false,
              runtimeStatus:
                "The next runtime launch uses a delegated systemd user scope, so Lando schedules native healthchecks.",
              context: { scheduler: "lando", nextLaunch: "delegated" },
            })
          : report({
              status: "warn",
              running: false,
              runtimeStatus: `The next runtime launch cannot use a delegated systemd user scope, so ${unscheduled}.`,
              context: { scheduler: "none", nextLaunch: "shared", reason: eligibility.reason },
              solution: delegatedScopeRemediation(eligibility.reason),
            }),
      ];
    }

    if (service.record.containerCgroups !== "delegated") {
      return [
        report({
          status: "warn",
          running: true,
          runtimeStatus: `The runtime service runs without a delegated systemd user scope, so ${unscheduled}.`,
          context: { scheduler: "none", servicePlacement: "shared" },
          solution:
            "Run `lando poweroff`, then start your apps again: the next launch uses a delegated systemd user scope.",
        }),
      ];
    }

    const runs = yield* (seams.healthRuns ?? ownedHealthRunsOverSocket)({
      socketPath: layout.providerSocketPath,
      env: input.env,
      dataRoot: input.userDataRoot,
    });
    const privateDir = yield* (seams.privateRuntimeDir ?? managedRuntimeDirForTeardown)(
      dirname(layout.runtimeRunDir),
    );
    if (runs === undefined || privateDir === undefined) {
      return [
        report({
          status: "warn",
          running: true,
          runtimeStatus:
            runs === undefined
              ? "Lando could not list the runtime's running containers, so it cannot tell whether their healthchecks are scheduled."
              : "Lando could not resolve the runtime's private directory, so it cannot find its healthcheck timers.",
          context: {
            scheduler: "lando",
            ...(runs === undefined ? { containers: "unreadable" } : { privateRuntimeDir: "unresolved" }),
          },
          solution:
            "Run `lando doctor` again once the runtime answers; if this persists, run `lando poweroff`, then start your apps again.",
        }),
      ];
    }
    const prefix = managedHealthUnitPrefix(privateDir);
    const units = new Set((seams.transientUnits ?? transientUnitFiles)(tools.userRuntimeDir) ?? []);
    const missing = runs.filter(
      (run) => !units.has(`${managedHealthUnitName(prefix, run.key, "main")}.timer`),
    ).length;
    return [
      missing === 0
        ? report({
            status: "pass",
            running: true,
            runtimeStatus: "Lando schedules native healthchecks with systemd user timers.",
            context: { scheduler: "lando", healthchecked: String(runs.length) },
          })
        : report({
            status: "warn",
            running: true,
            runtimeStatus: `${missing} running containers with healthchecks have no Lando timer, so their health is not updated.`,
            context: { scheduler: "lando", withoutTimer: String(missing) },
            solution:
              "Run `lando start` in any app on this runtime: Lando recreates missing healthcheck timers whenever it starts or stops containers.",
          }),
    ];
  }),
});
