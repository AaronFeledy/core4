import { ProbeError, ProbeTimeoutError, runProbe } from "@lando/sdk/probe";
import { PathsService } from "@lando/sdk/services";
import { Duration, Effect, Option, absurd } from "effect";
import { failCheck, passCheckNamed, warnCheck } from "./doctor-check-builders";
import {
  FilesystemWatchIO,
  type WatchAllocation,
  type WatchObservation,
  nativeWatchIO,
} from "./doctor-filesystem-watch-io";
import type { DoctorSubsystemCheck } from "./doctor-subsystem-checks";

const failureReason = (allocation: WatchAllocation): string => {
  switch (allocation.stage) {
    case "complete":
      return "allocated";
    case "cleanup":
      return "cleanup-failed";
    case "setup":
    case "watch":
      switch (allocation.errno) {
        case "ENOSPC":
          return allocation.stage === "setup"
            ? "temporary-storage-full"
            : "inotify-watch-budget-or-kernel-allocation";
        case "EMFILE":
          return allocation.stage === "setup"
            ? "process-fd-limit"
            : "process-fd-or-user-inotify-instance-limit";
        case "ENFILE":
          return "system-fd-limit";
        case "EACCES":
        case "EPERM":
          return "permission-denied";
        case "ENOSYS":
        case "ENOTSUP":
        case "EOPNOTSUPP":
        case "ERR_FEATURE_UNAVAILABLE_ON_PLATFORM":
          return "unsupported";
        default:
          return "unknown";
      }
    case "delivery":
      return "unknown";
    default:
      return absurd<never>(allocation);
  }
};

const remediation = (allocation: WatchAllocation): readonly string[] => {
  switch (allocation.stage) {
    case "complete":
      return [];
    case "cleanup":
      return [
        "Check temporary-directory permissions and close any remaining doctor watcher before removing its temporary directory manually.",
      ];
    case "setup":
      switch (allocation.errno) {
        case "ENOSPC":
          return ["Free space or inodes on the CLI host's temporary filesystem, then rerun doctor."];
        case "EACCES":
        case "EPERM":
          return ["Restore access to the CLI host's temporary directory, then rerun doctor."];
        default:
          return [
            "Check the temporary-directory setup errno and local file-descriptor availability, then rerun doctor.",
          ];
      }
    case "watch":
      switch (allocation.errno) {
        case "ENOSPC":
        case "EMFILE":
          return [
            "First reduce unnecessary file watchers: stop unused watch tasks and exclude generated or dependency directories from watch tools.",
            allocation.errno === "ENOSPC"
              ? "If allocation still fails, ask an administrator to check actual inotify watch usage and kernel resource availability before considering limit changes."
              : "If allocation still fails, ask an administrator to check process file descriptors and per-user inotify instances before considering limit changes.",
          ];
        case "EACCES":
        case "EPERM":
          return [
            "Check permissions and security policy for watching the CLI host's temporary directory, then rerun doctor.",
          ];
        case "ENFILE":
          return [
            "Reduce unnecessary open files; if allocation still fails, ask an administrator to inspect system-wide file-descriptor usage.",
          ];
        default:
          return [
            "Check whether native filesystem watching is supported on the CLI host's temporary filesystem and inspect the reported errno. Diagnose provider runtime/VM watching separately.",
          ];
      }
    case "delivery":
      return ["Inspect the reported event-delivery error on the CLI host, then rerun doctor."];
    default:
      return absurd<never>(allocation);
  }
};

const windowsFailureReason = (allocation: WatchAllocation): string => {
  switch (allocation.stage) {
    case "complete":
      return "event-delivered";
    case "cleanup":
      return "cleanup-failed";
    case "setup":
      return allocation.errno === "ENOSPC" ? "temporary-storage-full" : "temporary-directory-unavailable";
    case "watch":
      return allocation.errno === "EACCES" || allocation.errno === "EPERM"
        ? "permission-denied"
        : "watch-unavailable";
    case "delivery":
      return allocation.errno === "ETIMEDOUT" ? "event-not-delivered" : "probe-file-unavailable";
    default:
      return absurd<never>(allocation);
  }
};

const windowsRemediation = (allocation: WatchAllocation): readonly string[] => {
  switch (allocation.stage) {
    case "complete":
      return [];
    case "cleanup":
      return [
        "Check permissions on the CLI host's temporary directory and remove any leftover doctor probe files.",
      ];
    case "setup":
      return ["Check free space and permissions on the Windows temporary directory, then rerun doctor."];
    case "watch":
      return [
        "Check whether the Windows temporary directory permits native file watching. Close unnecessary watch tasks and rerun doctor; inspect the reported error if it still fails.",
      ];
    case "delivery":
      return allocation.errno === "ETIMEDOUT"
        ? [
            "The watcher opened, but its temporary-file event did not arrive. Check the Windows temporary filesystem and security software, then rerun doctor.",
          ]
        : [
            "Check whether the Windows temporary directory permits creating probe files and delivering file events, then rerun doctor.",
          ];
    default:
      return absurd<never>(allocation);
  }
};

export const filesystemWatchDoctor = Effect.fn("Doctor.filesystemWatch")(function* (
  redact: (text: string) => string,
  platform?: string,
): Effect.fn.Return<readonly DoctorSubsystemCheck[], ProbeError> {
  const paths = yield* Effect.serviceOption(PathsService);
  const host = platform ?? (Option.isSome(paths) ? paths.value.platform : process.platform);
  const base = {
    scope: "cli-host",
    platform: host,
    providerRuntime: "unobserved",
    providerVm: "unobserved",
    usage: "unknown",
    pressure: "unknown",
    eventDelivery: "unobserved",
    spareCapacity: "unknown",
    instanceHeadroom: "unknown",
  };
  const context = (values: Readonly<Record<string, string>>) =>
    Object.fromEntries(Object.entries({ ...base, ...values }).map(([key, value]) => [key, redact(value)]));
  const manual = (descriptions: readonly string[]) =>
    descriptions.map((description) => ({ kind: "manual" as const, description: redact(description) }));
  if (host !== "linux" && host !== "wsl" && host !== "win32") {
    return [
      warnCheck({
        name: "filesystem-watch",
        recovery: "manual",
        context: context({ observation: "unsupported-platform" }),
        solutions: manual([
          "This check supports Linux, WSL, and Windows CLI hosts. Use platform-native filesystem-watch diagnostics on this host; inspect provider runtime/VM watching separately.",
        ]),
      }),
    ];
  }
  const injected = yield* Effect.serviceOption(FilesystemWatchIO);
  const observation = FilesystemWatchIO.use((io) => io.observe);
  let observed: WatchObservation | undefined;
  const result = yield* runProbe(
    {
      id: "filesystem-watch",
      policy: { maxAttempts: 1, timeout: Duration.millis(host === "win32" ? 1500 : 500) },
    },
    (Option.isSome(injected)
      ? injected.value.observe
      : observation.pipe(Effect.provide(FilesystemWatchIO.layerWith(nativeWatchIO, host)))
    ).pipe(
      Effect.tap((value) =>
        Effect.sync(() => {
          observed = value;
        }),
      ),
    ),
  );
  if (result.outcome !== "green" || observed === undefined) {
    if (!(result.lastError instanceof ProbeTimeoutError)) {
      return yield* Effect.fail(
        new ProbeError({
          probeId: "filesystem-watch",
          message: "Filesystem-watch probe did not produce an observation.",
          cause: result.lastError,
        }),
      );
    }
    return [
      warnCheck({
        name: "filesystem-watch",
        recovery: "manual",
        context: context({
          observation: "unavailable",
          reason: "timeout",
          allocation: "unknown",
          cleanup: "pending-or-unobserved",
        }),
        solutions: manual([
          "The local watch probe timed out. Check CLI-host filesystem responsiveness and rerun doctor; allocation, event delivery, and cleanup could not be confirmed.",
        ]),
      }),
    ];
  }
  const allocation = observed.allocation;
  const fields = context({
    ...observed.limits,
    observation: host === "win32" ? "local-windows-temp-filesystem" : "local-linux-including-wsl",
    allocation:
      host === "win32"
        ? allocation.stage === "complete" && observed.eventDelivery !== "confirmed"
          ? "event-not-confirmed"
          : windowsFailureReason(allocation)
        : failureReason(allocation),
    eventDelivery: observed.eventDelivery,
    stage: allocation.stage,
    errno: "errno" in allocation ? allocation.errno : "none",
    cleanup: observed.cleanup,
    proof:
      allocation.stage === "complete" && (host !== "win32" || observed.eventDelivery === "confirmed")
        ? host === "win32"
          ? "one-point-in-time-nonrecursive-event-delivery-on-cli-host-temp"
          : "one-point-in-time-nonrecursive-allocation-only"
        : "none",
  });
  switch (allocation.stage) {
    case "complete":
      return host === "win32" && observed.eventDelivery !== "confirmed"
        ? [
            failCheck({
              name: "filesystem-watch",
              recovery: "manual",
              context: fields,
              solutions: manual([
                "The Windows watcher did not confirm a file event. Check the temporary filesystem and rerun doctor.",
              ]),
            }),
          ]
        : [passCheckNamed({ name: "filesystem-watch", recovery: "manual", context: fields })];
    case "setup":
    case "watch":
    case "delivery":
    case "cleanup":
      return [
        failCheck({
          name: "filesystem-watch",
          recovery: "manual",
          context: fields,
          solutions: manual(host === "win32" ? windowsRemediation(allocation) : remediation(allocation)),
        }),
      ];
    default:
      return absurd<never>(allocation);
  }
});
