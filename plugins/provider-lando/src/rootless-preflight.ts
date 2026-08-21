import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { ProviderUnavailableError } from "@lando/sdk/errors";

import { hasHostSystemd } from "./user-systemd-session.ts";

const PROVIDER_ID = "lando";
const MINIMUM_SUBORDINATE_ID_COUNT = 65536;

export type RootlessPrerequisite =
  | "subid"
  | "subid-range"
  | "subid-overlap"
  | "uidmap-tools"
  | "cgroups-v2-delegation"
  | "xdg-runtime-dir";

export type SubordinateIdEntry = {
  readonly user: string;
  readonly start: number;
  readonly count: number;
};

export type SubordinateIdRangeVerdict =
  | { readonly kind: "ok" }
  | { readonly kind: "missing" }
  | { readonly kind: "too-small"; readonly available: number }
  | { readonly kind: "overlap"; readonly withUser: string };

interface RootlessPrerequisiteCopy {
  readonly message: string;
  readonly remediation: string;
}

interface RootlessPrerequisiteDetails {
  readonly prerequisite: RootlessPrerequisite;
}

const rootlessPrerequisiteCopy: Record<RootlessPrerequisite, RootlessPrerequisiteCopy> = {
  subid: {
    message: "Rootless Podman requires subordinate UID/GID ranges for your user.",
    remediation:
      "Add a range for your user to /etc/subuid and /etc/subgid, e.g. `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER`, then rerun `lando setup`.",
  },
  "subid-range": {
    message: "Rootless Podman requires one contiguous subordinate UID/GID range with at least 65536 IDs.",
    remediation:
      "Assign a single range of at least 65536 IDs, e.g. `sudo usermod --add-subuids 100000-165535 --add-subgids 100000-165535 $USER`, then rerun `lando setup`.",
  },
  "subid-overlap": {
    message:
      "Rootless Podman requires subordinate UID/GID ranges that do not overlap another user's allocation.",
    remediation:
      "Inspect /etc/subuid and /etc/subgid, reassign a non-conflicting range for your user, then rerun `lando setup`.",
  },
  "uidmap-tools": {
    message: "Rootless Podman requires the newuidmap/newgidmap helper binaries.",
    remediation:
      "Install the uidmap tools (`sudo apt-get install uidmap` or `sudo dnf install shadow-utils`), then rerun `lando setup`.",
  },
  "cgroups-v2-delegation": {
    message: "Rootless Podman requires cgroups v2 controller delegation for your user session.",
    remediation:
      "Enable systemd user cgroup delegation (create /etc/systemd/system/user@.service.d/delegate.conf with `Delegate=cpu cpuset io memory pids`), run `systemctl daemon-reload`, then rerun `lando setup`. Alternatively, run `lando setup --provider=docker`.",
  },
  "xdg-runtime-dir": {
    message: "Rootless Podman requires XDG_RUNTIME_DIR to be set for your session.",
    remediation:
      "Start a full user session so XDG_RUNTIME_DIR is set, or export XDG_RUNTIME_DIR=/run/user/$(id -u), then rerun `lando setup`.",
  },
};

export const CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION =
  "This host is not running systemd (PID 1 is not systemd; /run/systemd/system is missing), so user cgroup delegation cannot be enabled. Install Docker and run `lando setup --provider=docker`.";

export interface CgroupsRemediationHost {
  readonly hasSystemd?: boolean;
}

export const cgroupsV2DelegationRemediation = (host: CgroupsRemediationHost = {}): string => {
  const hasSystemd = host.hasSystemd ?? hasHostSystemd();
  if (!hasSystemd) return CGROUPS_V2_DELEGATION_NO_SYSTEMD_REMEDIATION;
  return rootlessPrerequisiteCopy["cgroups-v2-delegation"].remediation;
};

export class RootlessPrerequisiteError extends ProviderUnavailableError {
  constructor(prerequisite: RootlessPrerequisite, cause?: unknown, host: CgroupsRemediationHost = {}) {
    const copy = rootlessPrerequisiteCopy[prerequisite];
    const remediation =
      prerequisite === "cgroups-v2-delegation" ? cgroupsV2DelegationRemediation(host) : copy.remediation;
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: copy.message,
      remediation,
      details: { prerequisite } satisfies RootlessPrerequisiteDetails,
      cause,
    });
  }

  get prerequisite(): RootlessPrerequisite {
    return (this.details as RootlessPrerequisiteDetails).prerequisite;
  }
}

export interface RootlessProbeResults {
  readonly subidConfigured: boolean;
  readonly subidRangeSufficient: boolean;
  readonly subidRangesDisjoint: boolean;
  readonly hasUidmapTools: boolean;
  readonly cgroupsV2Delegated: boolean;
  readonly hasXdgRuntimeDir: boolean;
}

export interface RootlessProbes {
  readonly probe: () => RootlessProbeResults;
}

type Environment = Readonly<Record<string, string | undefined>>;

export const parseSubordinateIdFile = (text: string): readonly SubordinateIdEntry[] => {
  const entries: SubordinateIdEntry[] = [];
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) continue;

    const fields = trimmed.split(":");
    if (fields.length !== 3) continue;
    const [rawUser, rawStart, rawCount] = fields;
    if (rawUser === undefined || rawStart === undefined || rawCount === undefined) continue;

    const user = rawUser.trim();
    const startText = rawStart.trim();
    const countText = rawCount.trim();
    if (user.length === 0 || !/^\d+$/u.test(startText) || !/^\d+$/u.test(countText)) continue;

    const start = Number(startText);
    const count = Number(countText);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(count) ||
      start + count > Number.MAX_SAFE_INTEGER
    ) {
      continue;
    }
    entries.push({ user, start, count });
  }
  return entries;
};

export const validateSubordinateIdRanges = (
  entries: readonly SubordinateIdEntry[],
  user: string,
): SubordinateIdRangeVerdict => {
  const userEntries = entries.filter((entry) => entry.user === user);
  if (userEntries.length === 0) return { kind: "missing" };

  const available = userEntries.reduce((largest, entry) => Math.max(largest, entry.count), 0);
  if (available < MINIMUM_SUBORDINATE_ID_COUNT) return { kind: "too-small", available };

  const conflicting = entries.find(
    (other) =>
      other.user !== user &&
      userEntries.some(
        (owned) => owned.start < other.start + other.count && other.start < owned.start + owned.count,
      ),
  );
  return conflicting === undefined ? { kind: "ok" } : { kind: "overlap", withUser: conflicting.user };
};

type SubordinateIdFileProbe = {
  readonly configured: boolean;
  readonly sufficient: boolean;
  readonly disjoint: boolean;
};

const failedSubordinateIdFileProbe: SubordinateIdFileProbe = {
  configured: false,
  sufficient: false,
  disjoint: false,
};

const probeSubordinateIdFile = (path: string, user: string): SubordinateIdFileProbe => {
  try {
    const verdict = validateSubordinateIdRanges(parseSubordinateIdFile(readFileSync(path, "utf8")), user);
    switch (verdict.kind) {
      case "missing":
        return { configured: false, sufficient: false, disjoint: true };
      case "too-small":
        return { configured: true, sufficient: false, disjoint: true };
      case "overlap":
        return { configured: true, sufficient: true, disjoint: false };
      case "ok":
        return { configured: true, sufficient: true, disjoint: true };
    }
  } catch {
    return failedSubordinateIdFileProbe;
  }
};

const hasExecutableOnPath = (binary: string, pathValue: string | undefined): boolean => {
  if (typeof pathValue !== "string" || pathValue.length === 0) {
    return false;
  }

  return pathValue
    .split(delimiter)
    .some((directory) => directory.length > 0 && existsSync(join(directory, binary)));
};

const uidFromRuntimeDir = (runtimeDir: string | undefined): string | undefined => {
  if (runtimeDir === undefined) return undefined;
  return runtimeDir.match(/(?:^|\/)run\/user\/(\d+)(?:\/|$)/u)?.[1];
};

export const hasCgroupsV2Delegation = (
  cgroupRoot = "/sys/fs/cgroup",
  uid = uidFromRuntimeDir(process.env.XDG_RUNTIME_DIR) ?? process.getuid?.().toString(),
): boolean => {
  if (uid === undefined || uid.length === 0) return false;

  const userSlice = join(cgroupRoot, "user.slice");
  // No systemd user hierarchy: Lando's managed runtime uses cgroupfs and does
  // not need user-session controller delegation.
  if (!existsSync(userSlice)) return true;

  try {
    return (
      readFileSync(
        join(userSlice, `user-${uid}.slice`, `user@${uid}.service`, "cgroup.controllers"),
        "utf8",
      ).trim().length > 0
    );
  } catch {
    return false;
  }
};

export const makeSystemRootlessProbes = (env: Environment = process.env): RootlessProbes => ({
  probe: () => {
    const user = env.USER;
    const subuid =
      typeof user === "string" && user.length > 0
        ? probeSubordinateIdFile("/etc/subuid", user)
        : failedSubordinateIdFileProbe;
    const subgid =
      typeof user === "string" && user.length > 0
        ? probeSubordinateIdFile("/etc/subgid", user)
        : failedSubordinateIdFileProbe;

    return {
      subidConfigured: subuid.configured && subgid.configured,
      subidRangeSufficient: subuid.sufficient && subgid.sufficient,
      subidRangesDisjoint: subuid.disjoint && subgid.disjoint,
      hasUidmapTools:
        hasExecutableOnPath("newuidmap", env.PATH) && hasExecutableOnPath("newgidmap", env.PATH),
      cgroupsV2Delegated: hasCgroupsV2Delegation("/sys/fs/cgroup", uidFromRuntimeDir(env.XDG_RUNTIME_DIR)),
      hasXdgRuntimeDir: typeof env.XDG_RUNTIME_DIR === "string" && env.XDG_RUNTIME_DIR.length > 0,
    };
  },
});

export const classifyRootlessFailure = (
  results: RootlessProbeResults,
  _stderr?: string,
  host: CgroupsRemediationHost = {},
): RootlessPrerequisiteError | undefined => {
  if (!results.subidConfigured) {
    return new RootlessPrerequisiteError("subid");
  }

  if (!results.subidRangeSufficient) {
    return new RootlessPrerequisiteError("subid-range");
  }

  if (!results.subidRangesDisjoint) {
    return new RootlessPrerequisiteError("subid-overlap");
  }

  if (!results.hasUidmapTools) {
    return new RootlessPrerequisiteError("uidmap-tools");
  }

  if (!results.cgroupsV2Delegated) {
    return new RootlessPrerequisiteError("cgroups-v2-delegation", undefined, host);
  }

  if (!results.hasXdgRuntimeDir) {
    return new RootlessPrerequisiteError("xdg-runtime-dir");
  }

  return undefined;
};
