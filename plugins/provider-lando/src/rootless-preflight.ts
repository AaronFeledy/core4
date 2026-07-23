import { existsSync, readFileSync } from "node:fs";
import { delimiter, join } from "node:path";

import { ProviderUnavailableError } from "@lando/sdk/errors";

const PROVIDER_ID = "lando";

export type RootlessPrerequisite = "subid" | "uidmap-tools" | "cgroups-v2-delegation" | "xdg-runtime-dir";

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
  "uidmap-tools": {
    message: "Rootless Podman requires the newuidmap/newgidmap helper binaries.",
    remediation:
      "Install the uidmap tools (`sudo apt-get install uidmap` or `sudo dnf install shadow-utils`), then rerun `lando setup`.",
  },
  "cgroups-v2-delegation": {
    message: "Rootless Podman requires cgroups v2 controller delegation for your user session.",
    remediation:
      "Enable systemd user cgroup delegation (create /etc/systemd/system/user@.service.d/delegate.conf with `Delegate=cpu cpuset io memory pids`), run `systemctl daemon-reload`, then rerun `lando setup`.",
  },
  "xdg-runtime-dir": {
    message: "Rootless Podman requires XDG_RUNTIME_DIR to be set for your session.",
    remediation:
      "Start a full user session so XDG_RUNTIME_DIR is set, or export XDG_RUNTIME_DIR=/run/user/$(id -u), then rerun `lando setup`.",
  },
};

export class RootlessPrerequisiteError extends ProviderUnavailableError {
  constructor(prerequisite: RootlessPrerequisite, cause?: unknown) {
    const copy = rootlessPrerequisiteCopy[prerequisite];
    super({
      providerId: PROVIDER_ID,
      operation: "setup",
      message: copy.message,
      remediation: copy.remediation,
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
  readonly hasUidmapTools: boolean;
  readonly cgroupsV2Delegated: boolean;
  readonly hasXdgRuntimeDir: boolean;
}

export interface RootlessProbes {
  readonly probe: () => RootlessProbeResults;
}

type Environment = Readonly<Record<string, string | undefined>>;

const hasSubordinateIdEntry = (path: string, user: string): boolean => {
  try {
    return readFileSync(path, "utf8")
      .split(/\r?\n/u)
      .some((line) => line.split(":", 1)[0] === user);
  } catch {
    return false;
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

  try {
    return (
      readFileSync(
        join(cgroupRoot, "user.slice", `user-${uid}.slice`, `user@${uid}.service`, "cgroup.controllers"),
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
    const subidConfigured =
      typeof user === "string" &&
      user.length > 0 &&
      hasSubordinateIdEntry("/etc/subuid", user) &&
      hasSubordinateIdEntry("/etc/subgid", user);

    return {
      subidConfigured,
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
): RootlessPrerequisiteError | undefined => {
  if (!results.subidConfigured) {
    return new RootlessPrerequisiteError("subid");
  }

  if (!results.hasUidmapTools) {
    return new RootlessPrerequisiteError("uidmap-tools");
  }

  if (!results.cgroupsV2Delegated) {
    return new RootlessPrerequisiteError("cgroups-v2-delegation");
  }

  if (!results.hasXdgRuntimeDir) {
    return new RootlessPrerequisiteError("xdg-runtime-dir");
  }

  return undefined;
};
