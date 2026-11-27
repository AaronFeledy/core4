import { existsSync, readFileSync } from "node:fs";

import { ProviderSetupUnsupportedHostError } from "@lando/sdk/errors";
import type { RetryPolicy } from "@lando/sdk/probe";
import { type HostPlatform, ProviderId, hostPlatformFamily } from "@lando/sdk/schema";
import type { HostChangeProposal } from "@lando/sdk/services";
import { Effect } from "effect";
import {
  manualUidmapRemediation,
  nextSubordinateStart,
  subordinateRangeChange,
  uidmapChange,
} from "./prerequisite-changes.ts";
import {
  type RootlessProbes,
  cgroupsV2DelegationRemediation,
  parseSubordinateIdFile,
  validateSubordinateIdRanges,
} from "./rootless-preflight.ts";
import { type UserManagerHost, resolveProcessUserName, unitLacksDelegation } from "./user-manager.ts";
import { DELEGATE_CONF_PATH, delegationChange, lingerChange } from "./user-manager-changes.ts";
import { hasHostSystemd } from "./user-systemd-session.ts";

const PROVIDER_ID = ProviderId.make("lando");
const DEFAULT_SUBID_START = 100000;
const DEFAULT_SUBID_COUNT = 65536;

export interface LinuxHostRelease {
  readonly id: string;
  readonly versionId: string;
}

export interface PrerequisiteInspection {
  readonly platform: HostPlatform;
  readonly host: LinuxHostRelease | undefined;
  readonly probes: RootlessProbes;
  readonly user: string | undefined;
  readonly hasSystemd?: boolean;
  /** Present on hosts where Lando can plan lingering for a missing systemd user manager. */
  readonly userManager?: UserManagerHost;
  /** Reads a host file such as `/etc/subuid`; undefined when it does not exist. */
  readonly readHostFile?: (path: string) => string | undefined;
  readonly pathExists?: (path: string) => boolean;
  /** Bounds the wait for the user manager after lingering is enabled. */
  readonly managerWaitPolicy?: RetryPolicy;
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

const readTextFile = (path: string): string | undefined => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
};

export const readLinuxHostRelease = (): LinuxHostRelease | undefined => {
  const text = readTextFile("/etc/os-release");
  return text === undefined ? undefined : parseLinuxHostRelease(text);
};

const unsupported = (
  input: PrerequisiteInspection,
  fields: { prerequisite: string; message: string; remediation: string },
) =>
  new ProviderSetupUnsupportedHostError({
    providerId: PROVIDER_ID,
    ...fields,
    ...(input.host === undefined ? {} : { host: input.host }),
  });

/**
 * Inspect the host read-only and propose the changes the managed runtime needs: uidmap on
 * Ubuntu and Debian, missing subordinate ranges, the cgroups delegation drop-in, and lingering
 * when no systemd user manager runs. Anything else missing fails closed with a manual remedy.
 */
export const planPrerequisiteHostChanges = Effect.fnUntraced(function* (
  input: PrerequisiteInspection,
): Effect.fn.Return<ReadonlyArray<HostChangeProposal>, ProviderSetupUnsupportedHostError> {
  const proposals: HostChangeProposal[] = [];
  const probeResults = input.probes.probe();
  const readHostFile = input.readHostFile ?? readTextFile;
  const pathExists = input.pathExists ?? input.userManager?.pathExists ?? existsSync;
  const hasSystemd = input.hasSystemd ?? hasHostSystemd();
  const user = input.userManager?.account()?.user ?? input.user ?? resolveProcessUserName() ?? "";

  if (!probeResults.hasUidmapTools) {
    const host = input.host;
    if (
      hostPlatformFamily(input.platform) !== "linux" ||
      host === undefined ||
      (host.id !== "ubuntu" && host.id !== "debian")
    ) {
      return yield* Effect.fail(
        unsupported(input, {
          prerequisite: "uidmap-tools",
          message:
            host === undefined
              ? "Automatic uidmap provisioning requires a recognized Linux distribution."
              : `Automatic uidmap provisioning is not supported on ${host.id}.`,
          remediation: manualUidmapRemediation,
        }),
      );
    }
    proposals.push(uidmapChange(host, input.probes));
  }

  if (!probeResults.subidConfigured && user.length > 0) {
    for (const kind of ["uid", "gid"] as const) {
      const text = readHostFile(kind === "uid" ? "/etc/subuid" : "/etc/subgid");
      const verdict =
        text === undefined ? "missing" : validateSubordinateIdRanges(parseSubordinateIdFile(text), user).kind;
      if (verdict !== "missing") continue;
      const range = {
        kind,
        user,
        start: nextSubordinateStart(text, DEFAULT_SUBID_START),
        count: DEFAULT_SUBID_COUNT,
      };
      proposals.push(subordinateRangeChange(range, readHostFile));
    }
  }

  // No user manager: plan lingering and the drop-in only when the unit is confirmed to lack
  // delegation. The running-manager checks below do not apply.
  const account = input.userManager?.account();
  if (
    input.userManager !== undefined &&
    account !== undefined &&
    hasSystemd &&
    !input.userManager.managerRunning(account.uid)
  ) {
    const unit = yield* input.userManager.showUnit(account.uid);
    if (unitLacksDelegation(unit)) {
      // systemd reads drop-ins when it loads the unit, and `systemctl show` just loaded it: a
      // drop-in that exists yet delegates nothing will not apply when lingering starts the manager.
      if (pathExists(DELEGATE_CONF_PATH)) {
        return yield* Effect.fail(
          unsupported(input, {
            prerequisite: "cgroups-delegation",
            message: `${DELEGATE_CONF_PATH} exists, but systemd does not delegate the cpu, memory, and pids controllers to user@${account.uid}.service.`,
            remediation: `Make sure ${DELEGATE_CONF_PATH} contains \`Delegate=cpu cpuset io memory pids\` under \`[Service]\`, run \`sudo systemctl daemon-reload\`, then rerun \`lando setup\`. Alternatively, run \`lando setup --provider=docker\`.`,
          }),
        );
      }
      proposals.push(delegationChange(false, pathExists));
    }
    proposals.push(lingerChange(account, input.userManager, input.managerWaitPolicy));
  } else if (!probeResults.cgroupsV2Delegated) {
    if (!hasSystemd) {
      return yield* Effect.fail(
        unsupported(input, {
          prerequisite: "cgroups-delegation",
          message:
            "Rootless Podman requires cgroups v2 controller delegation, but this host is not running systemd.",
          remediation: cgroupsV2DelegationRemediation({ hasSystemd: false }),
        }),
      );
    }
    if (pathExists(DELEGATE_CONF_PATH)) {
      // The drop-in exists but this session is not delegated: only a new login applies it.
      return yield* Effect.fail(
        unsupported(input, {
          prerequisite: "cgroups-delegation",
          message: "The cgroups delegation drop-in exists but your session is not delegated.",
          remediation:
            "Log out of your current session, log back in, then rerun `lando setup`. (The systemd delegation drop-in only applies to new user sessions.) Alternatively, run `lando setup --provider=docker`.",
        }),
      );
    }
    proposals.push(delegationChange(true, pathExists));
  }
  return proposals;
});
