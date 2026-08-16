import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { Effect } from "effect";

import {
  ProviderSetupPrivilegeUnavailableError,
  ProviderSetupProvisioningError,
  ProviderSetupUnsupportedHostError,
} from "@lando/sdk/errors";
import { type HostPlatform, ProviderId, type ProviderSetupPlan, hostPlatformFamily } from "@lando/sdk/schema";
import type { PrivilegeService } from "@lando/sdk/services";

import {
  type RootlessProbes,
  parseSubordinateIdFile,
  validateSubordinateIdRanges,
} from "./rootless-preflight.ts";

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
}

interface PrerequisiteApply {
  readonly probes: RootlessProbes;
  readonly privilege: typeof PrivilegeService.Service | undefined;
  readonly user: string | undefined;
}

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

export const inspectPrerequisiteSetupPlan = (
  input: PrerequisiteInspection,
): Effect.Effect<ProviderSetupPlan, ProviderSetupUnsupportedHostError> => {
  const changes: Array<ProviderSetupPlan["changes"][number]> = [];
  const probeResults = input.probes.probe();
  const user = input.user ?? process.env.USER ?? "";

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
      return Effect.fail(
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

  // Check cgroups delegation - only create drop-in when absent
  if (!probeResults.cgroupsV2Delegated && !existsSync(DELEGATE_CONF_PATH)) {
    changes.push({
      _tag: "provision-cgroups-delegation",
      path: DELEGATE_CONF_PATH,
      reason: "Rootless Podman requires cgroups v2 controller delegation for your user session.",
    });
  }

  return Effect.succeed({ providerId: PROVIDER_ID, changes: changes as ProviderSetupPlan["changes"] });
};

// Backward compatibility alias
export const inspectUidmapSetupPlan = inspectPrerequisiteSetupPlan;

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
    stderr: result.stderr,
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

export const applyApprovedPrerequisitePlan = (
  plan: ProviderSetupPlan,
  input: PrerequisiteApply,
): Effect.Effect<void, ProviderSetupPrivilegeUnavailableError | ProviderSetupProvisioningError> =>
  Effect.gen(function* () {
    const user = input.user ?? process.env.USER ?? "";

    for (const change of plan.changes) {
      if (input.privilege === undefined) {
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

      switch (change._tag) {
        case "install-uidmap": {
          const update = yield* input.privilege.elevate(APT_GET_UPDATE);
          if (update.exitCode !== 0) return yield* Effect.fail(provisioningFailure("update", update));
          const install = yield* input.privilege.elevate(APT_GET_INSTALL_UIDMAP);
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
          const { start, count } = change as { start: number; count: number };

          // Find a non-conflicting range
          const actualStart = findNextAvailableRange(path, start);

          // Use usermod if available
          const usermodCmd = [
            "/usr/sbin/usermod",
            isSubuid ? "--add-subuids" : "--add-subgids",
            `${actualStart}-${actualStart + count - 1}`,
            user,
          ] as const;

          const result = yield* input.privilege.elevate(usermodCmd);

          if (result.exitCode !== 0) {
            // Fallback: try direct file append if usermod fails
            try {
              const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
              const entry = `${user}:${actualStart}:${count}\n`;
              writeFileSync(path, existing + entry, { mode: 0o644 });
            } catch (_error) {
              return yield* Effect.fail(
                new ProviderSetupProvisioningError({
                  providerId: PROVIDER_ID,
                  change: change._tag,
                  stage: "install",
                  message: `Failed to provision ${isSubuid ? "subordinate UID" : "subordinate GID"} range.`,
                  remediation: `Manually add a range for your user to ${path}, e.g. \`sudo usermod ${isSubuid ? "--add-subuids" : "--add-subgids"} 100000-165535 $USER\`, then rerun \`lando setup\`.`,
                  exitCode: result.exitCode,
                  stderr: result.stderr,
                }),
              );
            }
          }
          break;
        }

        case "provision-cgroups-delegation": {
          const { path } = change as { path: string };

          try {
            // Create the drop-in directory if it doesn't exist
            const dir = dirname(path);
            const mkdirCmd = ["/usr/bin/mkdir", "-p", dir] as const;
            const mkdirResult = yield* input.privilege.elevate(mkdirCmd);
            if (mkdirResult.exitCode !== 0) {
              return yield* Effect.fail(
                new ProviderSetupProvisioningError({
                  providerId: PROVIDER_ID,
                  change: change._tag,
                  stage: "install",
                  message: "Failed to create systemd user@.service.d directory.",
                  remediation:
                    "Manually create the directory and delegation config, then rerun `lando setup`.",
                  exitCode: mkdirResult.exitCode,
                  stderr: mkdirResult.stderr,
                }),
              );
            }

            // Write the delegation config using sh -c with echo
            const writeCmd = ["/bin/sh", "-c", `echo '${DELEGATE_CONF_CONTENT}' > ${path}`] as const;
            const writeResult = yield* input.privilege.elevate(writeCmd);
            if (writeResult.exitCode !== 0) {
              return yield* Effect.fail(
                new ProviderSetupProvisioningError({
                  providerId: PROVIDER_ID,
                  change: change._tag,
                  stage: "install",
                  message: "Failed to write cgroups delegation drop-in.",
                  remediation:
                    "Manually create /etc/systemd/system/user@.service.d/delegate.conf with `Delegate=cpu cpuset io memory pids`, run `sudo systemctl daemon-reload`, then rerun `lando setup`.",
                  exitCode: writeResult.exitCode,
                  stderr: writeResult.stderr,
                }),
              );
            }

            // Reload systemd to pick up the new drop-in
            const reloadCmd = ["/usr/bin/systemctl", "daemon-reload"] as const;
            const reload = yield* input.privilege.elevate(reloadCmd);
            if (reload.exitCode !== 0) {
              return yield* Effect.fail(
                new ProviderSetupProvisioningError({
                  providerId: PROVIDER_ID,
                  change: change._tag,
                  stage: "install",
                  message: "Created cgroups delegation drop-in, but systemd daemon-reload failed.",
                  remediation: "Run `sudo systemctl daemon-reload` manually, then rerun `lando setup`.",
                }),
              );
            }
          } catch (_error) {
            return yield* Effect.fail(
              new ProviderSetupProvisioningError({
                providerId: PROVIDER_ID,
                change: change._tag,
                stage: "install",
                message: "Failed to create cgroups delegation drop-in.",
                remediation:
                  "Manually create /etc/systemd/system/user@.service.d/delegate.conf with `Delegate=cpu cpuset io memory pids`, run `sudo systemctl daemon-reload`, then rerun `lando setup`.",
              }),
            );
          }
          break;
        }
      }
    }
  });

// Backward compatibility alias
export const applyApprovedProviderSetupPlan = applyApprovedPrerequisitePlan;
