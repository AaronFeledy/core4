import { existsSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { redactString, standaloneSecretsRedactor } from "@lando/container-runtime/redact";
import {
  type PrivilegeError,
  ProviderSetupPrivilegeUnavailableError,
  ProviderSetupProvisioningError,
  ProviderSetupUnsupportedHostError,
} from "@lando/sdk/errors";
import { type RetryPolicy, runProbe } from "@lando/sdk/probe";
import {
  type HostPlatform,
  ProviderId,
  type ProviderSetupHostChangeTag,
  type ProviderSetupPlan,
  hostPlatformFamily,
} from "@lando/sdk/schema";
import type { PrivilegeService, ProcessResult } from "@lando/sdk/services";
import { Duration, Effect } from "effect";
import {
  type RootlessProbes,
  cgroupsV2DelegationRemediation,
  parseSubordinateIdFile,
  validateSubordinateIdRanges,
} from "./rootless-preflight.ts";
import { type UserManagerHost, resolveProcessUserName, unitLacksDelegation } from "./user-manager.ts";
import { hasHostSystemd } from "./user-systemd-session.ts";

const hostSecretsRedactor = () => standaloneSecretsRedactor({ ...process.env });

const PROVIDER_ID = ProviderId.make("lando");
const APT_GET_UPDATE = ["/usr/bin/apt-get", "update"] as const;
const APT_GET_INSTALL_UIDMAP = [
  "/usr/bin/apt-get",
  "install",
  "--yes",
  "--no-install-recommends",
  "uidmap",
] as const;
const DEFAULT_SUBID_START = 100000;
const DEFAULT_SUBID_COUNT = 65536;
const DELEGATE_CONF_PATH = "/etc/systemd/system/user@.service.d/delegate.conf";
const DELEGATE_CONF_CONTENT = `[Service]
Delegate=cpu cpuset io memory pids
`;

export interface LinuxHostRelease {
  readonly id: string;
  readonly versionId: string;
}

interface PrerequisiteInspection {
  readonly platform: HostPlatform;
  readonly host: LinuxHostRelease | undefined;
  readonly probes: RootlessProbes;
  readonly user: string | undefined;
  readonly hasSystemd?: boolean;
  /** Present on hosts where Lando can plan lingering for a missing systemd user manager. */
  readonly userManager?: UserManagerHost;
  /** The user passed the provider's `--enable-linger` setup flag. */
  readonly lingerOptIn?: boolean;
}

interface PrerequisiteApply {
  readonly probes: RootlessProbes;
  readonly privilege: typeof PrivilegeService.Service | undefined;
  readonly user: string | undefined;
  readonly hasSystemd?: boolean;
  readonly userManager?: UserManagerHost;
  /** Bounds the wait for the user manager after lingering is enabled. */
  readonly managerWaitPolicy?: RetryPolicy;
}

const defaultManagerWaitPolicy: RetryPolicy = {
  maxAttempts: 60,
  delay: Duration.millis(250),
  timeout: Duration.seconds(20),
};

const parseReleaseValue = (raw: string): string => raw.trim().replace(/^['"]|['"]$/gu, "");

export const parseLinuxHostRelease = (raw: string): LinuxHostRelease | undefined => {
  const values = new Map(
    raw
      .split(/\r?\n/gu)
      .map((line) => line.match(/^([A-Z_]+)=(.*)$/u))
      .filter((match): match is RegExpMatchArray => match !== null)
      .map((match) => [match[1] ?? "", parseReleaseValue(match[2] ?? "")] as const),
  );
  const id = values.get("ID");
  const versionId = values.get("VERSION_ID");
  return id === undefined || versionId === undefined ? undefined : { id, versionId };
};

export const readLinuxHostRelease = (): LinuxHostRelease | undefined => {
  try {
    return parseLinuxHostRelease(readFileSync("/etc/os-release", "utf8"));
  } catch {
    return undefined;
  }
};

const manualUidmapRemediation =
  "Install newuidmap and newgidmap using the host's trusted package manager (`sudo apt-get install uidmap` or `sudo dnf install shadow-utils`), then rerun `lando setup`.";

export const inspectPrerequisiteSetupPlan = Effect.fnUntraced(function* (
  input: PrerequisiteInspection,
): Effect.fn.Return<ProviderSetupPlan, ProviderSetupUnsupportedHostError> {
  const changes: Array<ProviderSetupPlan["changes"][number]> = [];
  const probeResults = input.probes.probe();
  const user = input.userManager?.account()?.user ?? input.user ?? resolveProcessUserName() ?? "";

  // Check uidmap tools
  if (!probeResults.hasUidmapTools) {
    // Auto-provision on Ubuntu and Debian (use apt-get)
    if (
      hostPlatformFamily(input.platform) === "linux" &&
      input.host !== undefined &&
      (input.host.id === "ubuntu" || input.host.id === "debian")
    ) {
      changes.push({
        _tag: "install-uidmap",
        platform: "linux",
        distribution: input.host.id,
        version: input.host.versionId,
        reason: "Rootless Podman requires newuidmap and newgidmap before the managed runtime can start.",
      });
    } else {
      // Unsupported distribution - fail with manual remediation
      return yield* Effect.fail(
        new ProviderSetupUnsupportedHostError({
          providerId: PROVIDER_ID,
          prerequisite: "uidmap-tools",
          message:
            input.host === undefined
              ? "Automatic uidmap provisioning requires a recognized Linux distribution."
              : `Automatic uidmap provisioning is not supported on ${input.host.id}.`,
          remediation: manualUidmapRemediation,
          ...(input.host === undefined ? {} : { host: input.host }),
        }),
      );
    }
  }

  // Check subuid/subgid - only add when completely missing
  if (!probeResults.subidConfigured && user.length > 0) {
    const subuid = existsSync("/etc/subuid")
      ? validateSubordinateIdRanges(parseSubordinateIdFile(readFileSync("/etc/subuid", "utf8")), user)
      : { kind: "missing" as const };
    const subgid = existsSync("/etc/subgid")
      ? validateSubordinateIdRanges(parseSubordinateIdFile(readFileSync("/etc/subgid", "utf8")), user)
      : { kind: "missing" as const };

    if (subuid.kind === "missing") {
      changes.push({
        _tag: "provision-subuid",
        user,
        start: DEFAULT_SUBID_START,
        count: DEFAULT_SUBID_COUNT,
        reason: "Rootless Podman requires subordinate UID ranges for your user.",
      });
    }

    if (subgid.kind === "missing") {
      changes.push({
        _tag: "provision-subgid",
        user,
        start: DEFAULT_SUBID_START,
        count: DEFAULT_SUBID_COUNT,
        reason: "Rootless Podman requires subordinate GID ranges for your user.",
      });
    }
  }

  // No user manager: plan lingering (its own consent) and the drop-in only when the unit is
  // confirmed to lack delegation. The running-manager checks below do not apply.
  const account = input.userManager?.account();
  if (
    input.userManager !== undefined &&
    account !== undefined &&
    (input.hasSystemd ?? hasHostSystemd()) &&
    !input.userManager.managerRunning(account.uid)
  ) {
    const unit = yield* input.userManager.showUnit(account.uid);
    if (unitLacksDelegation(unit)) {
      // systemd reads drop-ins when it loads the unit, and `systemctl show` just loaded it: a
      // drop-in that exists yet delegates nothing will not apply when lingering starts the manager.
      if (input.userManager.pathExists(DELEGATE_CONF_PATH)) {
        return yield* Effect.fail(
          new ProviderSetupUnsupportedHostError({
            providerId: PROVIDER_ID,
            prerequisite: "cgroups-delegation",
            message: `${DELEGATE_CONF_PATH} exists, but systemd does not delegate the cpu, memory, and pids controllers to user@${account.uid}.service.`,
            remediation: `Make sure ${DELEGATE_CONF_PATH} contains \`Delegate=cpu cpuset io memory pids\` under \`[Service]\`, run \`sudo systemctl daemon-reload\`, then rerun \`lando setup\`. Alternatively, run \`lando setup --provider=docker\`.`,
            ...(input.host === undefined ? {} : { host: input.host }),
          }),
        );
      }
      changes.push({
        _tag: "provision-cgroups-delegation",
        path: DELEGATE_CONF_PATH,
        reason: "Rootless Podman requires cgroups v2 controller delegation for your user session.",
      });
    }
    changes.push({
      _tag: "enable-user-linger",
      user: account.user,
      uid: account.uid,
      optedIn: input.lingerOptIn === true,
      reason: `No systemd user manager runs for ${account.user}, so Lando's container runtime cannot give containers their own cgroups or apply deploy.resources limits. Enabling lingering starts one without a login session.`,
    });
  } else if (!probeResults.cgroupsV2Delegated) {
    const hasSystemd = input.hasSystemd ?? hasHostSystemd();
    if (!hasSystemd) {
      return yield* Effect.fail(
        new ProviderSetupUnsupportedHostError({
          providerId: PROVIDER_ID,
          prerequisite: "cgroups-delegation",
          message:
            "Rootless Podman requires cgroups v2 controller delegation, but this host is not running systemd.",
          remediation: cgroupsV2DelegationRemediation({ hasSystemd: false }),
          ...(input.host === undefined ? {} : { host: input.host }),
        }),
      );
    }
    if (!existsSync(DELEGATE_CONF_PATH)) {
      changes.push({
        _tag: "provision-cgroups-delegation",
        path: DELEGATE_CONF_PATH,
        reason: "Rootless Podman requires cgroups v2 controller delegation for your user session.",
      });
    } else {
      // Drop-in exists but delegation isn't active - user needs to log out/back in
      return yield* Effect.fail(
        new ProviderSetupUnsupportedHostError({
          providerId: PROVIDER_ID,
          prerequisite: "cgroups-delegation",
          message: "The cgroups delegation drop-in exists but your session is not delegated.",
          remediation:
            "Log out of your current session, log back in, then rerun `lando setup`. (The systemd delegation drop-in only applies to new user sessions.) Alternatively, run `lando setup --provider=docker`.",
          ...(input.host === undefined ? {} : { host: input.host }),
        }),
      );
    }
  }

  return { providerId: PROVIDER_ID, changes: changes as ProviderSetupPlan["changes"] };
});

const provisioningFailure = (
  stage: "update" | "install",
  result: { readonly exitCode: number; readonly stderr: string },
): ProviderSetupProvisioningError =>
  new ProviderSetupProvisioningError({
    providerId: PROVIDER_ID,
    change: "install-uidmap",
    stage,
    message: `Failed to ${stage === "update" ? "refresh apt-get package metadata" : "install uidmap"}.`,
    remediation:
      "Resolve the apt-get failure, then rerun `lando setup --yes`; or install uidmap tools manually.",
    exitCode: result.exitCode,
    stderr: redactString(result.stderr, hostSecretsRedactor()),
  });

const findNextAvailableRange = (path: string, requestedStart: number): number => {
  if (!existsSync(path)) return requestedStart;

  const entries = parseSubordinateIdFile(readFileSync(path, "utf8"));
  if (entries.length === 0) return requestedStart;

  // Find the highest allocated range end
  const maxEnd = entries.reduce((max, entry) => Math.max(max, entry.start + entry.count), 0);

  // Start after the highest allocated range, or use requested start if higher
  return Math.max(requestedStart, maxEnd);
};

const privilegeUnavailable = (change: ProviderSetupHostChangeTag, error: PrivilegeError) =>
  new ProviderSetupPrivilegeUnavailableError({
    providerId: PROVIDER_ID,
    change,
    message: error.message,
    remediation: error.remediation,
    cause: error,
  });

const MANUAL_DELEGATION_REMEDIATION =
  "Manually create /etc/systemd/system/user@.service.d/delegate.conf with `Delegate=cpu cpuset io memory pids`, run `sudo systemctl daemon-reload`, then rerun `lando setup`.";

export const applyApprovedPrerequisitePlan = Effect.fn("ProviderLando.applyApprovedPrerequisitePlan")(
  function* (
    plan: ProviderSetupPlan,
    input: PrerequisiteApply,
  ): Effect.fn.Return<void, ProviderSetupPrivilegeUnavailableError | ProviderSetupProvisioningError> {
    const privilege = input.privilege;
    // A manager that is not running yet starts with the drop-in, so no new login is needed.
    const managerStartsLater = plan.changes.some((change) => change._tag === "enable-user-linger");

    for (const change of plan.changes) {
      if (privilege === undefined) {
        return yield* Effect.fail(
          new ProviderSetupPrivilegeUnavailableError({
            providerId: PROVIDER_ID,
            change: change._tag,
            message: "The privilege service is unavailable, so Lando cannot provision prerequisites.",
            remediation:
              change._tag === "install-uidmap"
                ? manualUidmapRemediation
                : "Manually configure the prerequisite, then rerun `lando setup`.",
          }),
        );
      }
      const elevate = (
        command: ReadonlyArray<string>,
      ): Effect.Effect<ProcessResult, ProviderSetupPrivilegeUnavailableError> =>
        privilege
          .elevate(command)
          .pipe(Effect.catch((error) => Effect.fail(privilegeUnavailable(change._tag, error))));

      switch (change._tag) {
        case "install-uidmap": {
          const update = yield* elevate(APT_GET_UPDATE);
          if (update.exitCode !== 0) return yield* Effect.fail(provisioningFailure("update", update));
          const install = yield* elevate(APT_GET_INSTALL_UIDMAP);
          if (install.exitCode !== 0) return yield* Effect.fail(provisioningFailure("install", install));
          if (!input.probes.probe().hasUidmapTools) {
            return yield* Effect.fail(
              new ProviderSetupProvisioningError({
                providerId: PROVIDER_ID,
                change: change._tag,
                stage: "verify",
                message: "uidmap installation completed, but newuidmap/newgidmap remain unavailable.",
                remediation:
                  "Verify /usr/bin/newuidmap and /usr/bin/newgidmap are executable, then rerun `lando setup`.",
              }),
            );
          }
          break;
        }

        case "provision-subuid":
        case "provision-subgid": {
          const isSubuid = change._tag === "provision-subuid";
          const path = isSubuid ? "/etc/subuid" : "/etc/subgid";
          const actualStart = findNextAvailableRange(path, change.start);
          const result = yield* elevate([
            "/usr/sbin/usermod",
            isSubuid ? "--add-subuids" : "--add-subgids",
            `${actualStart}-${actualStart + change.count - 1}`,
            change.user,
          ]);
          if (result.exitCode !== 0) {
            return yield* Effect.fail(
              new ProviderSetupProvisioningError({
                providerId: PROVIDER_ID,
                change: change._tag,
                stage: "provision",
                message: `Failed to provision ${isSubuid ? "subordinate UID" : "subordinate GID"} range.`,
                remediation: `Manually add a range for your user to ${path}, e.g. \`sudo usermod ${isSubuid ? "--add-subuids" : "--add-subgids"} 100000-165535 $USER\`, then rerun \`lando setup\`.`,
                exitCode: result.exitCode,
                stderr: redactString(result.stderr, hostSecretsRedactor()),
              }),
            );
          }
          break;
        }

        case "provision-cgroups-delegation": {
          if (!(input.hasSystemd ?? hasHostSystemd())) {
            return yield* Effect.fail(
              new ProviderSetupProvisioningError({
                providerId: PROVIDER_ID,
                change: change._tag,
                stage: "install",
                message:
                  "Cannot enable systemd user cgroup delegation because this host is not running systemd.",
                remediation: cgroupsV2DelegationRemediation({ hasSystemd: false }),
              }),
            );
          }
          const mkdirResult = yield* elevate(["/usr/bin/mkdir", "-p", dirname(change.path)]);
          if (mkdirResult.exitCode !== 0) {
            return yield* Effect.fail(
              new ProviderSetupProvisioningError({
                providerId: PROVIDER_ID,
                change: change._tag,
                stage: "install",
                message: "Failed to create systemd user@.service.d directory.",
                remediation: "Manually create the directory and delegation config, then rerun `lando setup`.",
                exitCode: mkdirResult.exitCode,
                stderr: redactString(mkdirResult.stderr, hostSecretsRedactor()),
              }),
            );
          }
          const writeResult = yield* elevate([
            "/bin/sh",
            "-c",
            `echo '${DELEGATE_CONF_CONTENT}' > ${change.path}`,
          ]);
          if (writeResult.exitCode !== 0) {
            return yield* Effect.fail(
              new ProviderSetupProvisioningError({
                providerId: PROVIDER_ID,
                change: change._tag,
                stage: "install",
                message: "Failed to write cgroups delegation drop-in.",
                remediation: MANUAL_DELEGATION_REMEDIATION,
                exitCode: writeResult.exitCode,
                stderr: redactString(writeResult.stderr, hostSecretsRedactor()),
              }),
            );
          }
          const reload = yield* elevate(["/usr/bin/systemctl", "daemon-reload"]);
          if (reload.exitCode !== 0) {
            return yield* Effect.fail(
              new ProviderSetupProvisioningError({
                providerId: PROVIDER_ID,
                change: change._tag,
                stage: "reload",
                message:
                  "Created cgroups delegation drop-in, but systemd daemon-reload failed. The delegation will not take effect until you log out and back in.",
                remediation:
                  "Run `sudo systemctl daemon-reload`, then log out of your current session and log back in. After logging back in, rerun `lando setup`.",
              }),
            );
          }
          if (managerStartsLater) break;
          // A running user manager keeps its old controllers until it restarts with a new login.
          return yield* Effect.fail(
            new ProviderSetupProvisioningError({
              providerId: PROVIDER_ID,
              change: change._tag,
              stage: "reload",
              message:
                "Created cgroups delegation drop-in successfully. Log out of your current session and log back in for the delegation to take effect.",
              remediation: "Log out, log back in, then rerun `lando setup`.",
            }),
          );
        }

        case "enable-user-linger": {
          yield* enableUserLinger(change, elevate, input);
          break;
        }

        default: {
          const exhaustive: never = change;
          return exhaustive;
        }
      }
    }
  },
);

const lingerFailure = (
  stage: "provision" | "verify",
  message: string,
  remediation: string,
  result?: ProcessResult,
) =>
  new ProviderSetupProvisioningError({
    providerId: PROVIDER_ID,
    change: "enable-user-linger",
    stage,
    message,
    remediation,
    ...(result === undefined
      ? {}
      : { exitCode: result.exitCode, stderr: redactString(result.stderr, hostSecretsRedactor()) }),
  });

/**
 * `loginctl enable-linger` asks logind to start the user's manager. Lando waits for its private
 * socket, starts `user@<uid>.service` only when it is still not running, and never restarts one.
 * Neither command blocks (`--no-block`), and the wait is bounded.
 */
const enableUserLinger = Effect.fnUntraced(function* (
  change: { readonly user: string; readonly uid: number },
  elevate: (
    command: ReadonlyArray<string>,
  ) => Effect.Effect<ProcessResult, ProviderSetupPrivilegeUnavailableError>,
  input: PrerequisiteApply,
) {
  const manual = `Run \`loginctl enable-linger ${change.user}\` yourself, check \`systemctl status user@${change.uid}.service\`, then rerun \`lando setup\`.`;
  const managerDidNotStart = "Lingering is enabled, but the systemd user manager did not start.";
  const enabled = yield* elevate(["/usr/bin/loginctl", "enable-linger", change.user]);
  if (enabled.exitCode !== 0) {
    return yield* Effect.fail(lingerFailure("provision", "Failed to enable lingering.", manual, enabled));
  }
  const userManager = input.userManager;
  if (userManager === undefined) return;
  const waitForManager = runProbe(
    { id: "provider-lando-user-manager", policy: input.managerWaitPolicy ?? defaultManagerWaitPolicy },
    Effect.suspend(() =>
      userManager.managerRunning(change.uid) ? Effect.void : Effect.fail("user manager socket missing"),
    ),
  ).pipe(
    Effect.map((result) => result.outcome === "green"),
    Effect.catchTag("ProbeError", () => Effect.succeed(false)),
  );
  if (yield* waitForManager) return;
  const started = yield* elevate(["/usr/bin/systemctl", "start", "--no-block", `user@${change.uid}.service`]);
  if (started.exitCode !== 0) {
    return yield* Effect.fail(lingerFailure("verify", managerDidNotStart, manual, started));
  }
  if (yield* waitForManager) return;
  return yield* Effect.fail(lingerFailure("verify", managerDidNotStart, manual));
});
