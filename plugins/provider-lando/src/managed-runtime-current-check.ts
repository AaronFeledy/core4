import { runtimeLayoutPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import { hostPlatformFamily } from "@lando/sdk/schema";
import { Effect } from "effect";

import { managedRuntimePodmanArgv0 } from "./managed-runtime-service.ts";
import {
  NATIVE_HEALTH_RUNTIME_VERSION,
  type NativeHealthScheduling,
  managedNativeHealthScheduling,
} from "./native-health-runtime.ts";
import { buildPodmanServiceArgs } from "./podman-service-args.ts";
import { type PodmanServiceRunner, makeSystemPodmanServiceRunner } from "./podman-service-runner.ts";
import { RUNTIME_BUNDLE_MANIFEST } from "./runtime-bundle.ts";
import { readInstalledVersion } from "./runtime-extract.ts";

const CHECK = "managed-runtime-current";

export interface ManagedRuntimeCurrentCheckSeams {
  readonly serviceRunner?: Pick<PodmanServiceRunner, "isAlive" | "isServiceProcess" | "isDescendant">;
  /** Runtime version this Lando build installs. */
  readonly pinnedVersion?: string;
}

const schedulingContext = (scheduling: NativeHealthScheduling): string => {
  if (scheduling.scheduled) return scheduling.by === "service" ? "scheduled" : "next-launch";
  return scheduling.reason === "unacknowledged" ? "unacknowledged" : "unavailable";
};

/**
 * Whether the installed managed Linux runtime is the one this Lando build installs, and whether
 * its service schedules native healthchecks. It only warns: an older runtime keeps working.
 */
export const makeManagedRuntimeCurrentCheck = (
  seams: ManagedRuntimeCurrentCheckSeams = {},
): PluginDoctorCheckContribution => ({
  id: CHECK,
  run: Effect.fn("ManagedRuntimeCurrentCheck.run")(function* (input) {
    if (
      input.providerId !== "lando" ||
      hostPlatformFamily(input.platform) !== "linux" ||
      input.userDataRoot === undefined
    )
      return [];
    const layout = runtimeLayoutPaths(input.userDataRoot, "linux");
    const installedVersion = yield* readInstalledVersion(layout.runtimeBinDir);
    // No installed runtime is a setup problem, which the setup checks report.
    if (installedVersion === undefined || installedVersion.length === 0) return [];
    const pinnedVersion = seams.pinnedVersion ?? RUNTIME_BUNDLE_MANIFEST.runtimeVersion;
    const scheduling = yield* managedNativeHealthScheduling({
      installedVersion,
      runRoot: layout.runtimeRunDir,
      pidPath: layout.providerPidPath,
      spec: buildPodmanServiceArgs({
        podmanBin: managedRuntimePodmanArgv0(layout.runtimeBinDir, "linux"),
        storageDir: layout.runtimeStorageDir,
        runRoot: layout.runtimeRunDir,
        configDir: layout.runtimeConfigDir,
        socketPath: layout.providerSocketPath,
        privateRuntimeDir: undefined,
      }),
      serviceRunner: seams.serviceRunner ?? makeSystemPodmanServiceRunner(),
    });
    const context = {
      installedVersion,
      pinnedVersion,
      nativeHealthScheduling: schedulingContext(scheduling),
    };
    const outdated = Bun.semver.order(installedVersion, pinnedVersion) < 0;
    const report = (
      fields: Pick<PluginDoctorReport, "status" | "runtimeStatus" | "solutions">,
    ): PluginDoctorReport => ({
      name: CHECK,
      severity: fields.status === "pass" ? "info" : "warn",
      context,
      ...fields,
    });

    if (outdated) {
      const health = scheduling.scheduled
        ? ""
        : ` Native healthchecks are not scheduled until it runs ${NATIVE_HEALTH_RUNTIME_VERSION} or newer, so their health reads \`unknown\`.`;
      return [
        report({
          status: "warn",
          runtimeStatus: `The Lando runtime is ${installedVersion}, older than ${pinnedVersion}, which this Lando build installs.${health}`,
          solutions: [{ kind: "manual", description: "Run `lando setup` to update the Lando runtime." }],
        }),
      ];
    }
    if (scheduling.scheduled) {
      return [
        report({
          status: "pass",
          runtimeStatus:
            scheduling.by === "service"
              ? `The Lando runtime ${installedVersion} is current, and its service schedules native healthchecks.`
              : `The Lando runtime ${installedVersion} is current; the next time Lando launches its service, that service schedules native healthchecks.`,
          solutions: [],
        }),
      ];
    }
    if (scheduling.reason === "unacknowledged") {
      return [
        report({
          status: "warn",
          runtimeStatus: `The Lando runtime ${installedVersion} is current, and its running service was launched to schedule native healthchecks but never acknowledged that it does, so health reads \`unknown\`.`,
          solutions: [{ kind: "manual", description: scheduling.remediation }],
        }),
      ];
    }
    return [
      report({
        status: "pass",
        runtimeStatus: `The Lando runtime ${installedVersion} is current for this Lando build. Native healthchecks need runtime ${NATIVE_HEALTH_RUNTIME_VERSION} or newer, which this build does not install, so their health reads \`unknown\`.`,
        solutions: [],
      }),
    ];
  }),
});
