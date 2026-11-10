import { constants, accessSync, existsSync, readFileSync, statSync } from "node:fs";

import { MANAGED_SCOPE_ENV_BIN } from "@lando/container-runtime/podman/managed-invocation";
import { type HostPlatform, hostPlatformFamily } from "@lando/sdk/schema";

/**
 * Where the managed Linux service puts containers. `delegated`: the service runs in a cgroup the
 * user owns with the memory, pids and cpu controllers, so Podman gives each container its own
 * cgroup and resource limits apply. `shared`: containers run in the service's cgroup unlimited.
 */
export type ContainerCgroups = "delegated" | "shared";

const REQUIRED_CONTROLLERS = ["memory", "pids", "cpu"] as const;
// Absolute host locations only: the runtime-bin `systemd-run` shim must never launch the service.
const HOST_SYSTEMD_RUN = ["/usr/bin/systemd-run", "/bin/systemd-run"] as const;
const CGROUP_ROOT = "/sys/fs/cgroup";

/** Host reads behind delegated-scope decisions; tests inject a fake host. */
export interface DelegatedScopeHost {
  readonly uid: () => number | undefined;
  readonly isExecutable: (path: string) => boolean;
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string | undefined;
  readonly ownerUid: (path: string) => number | undefined;
}

export type DelegatedScopeIneligibility =
  | "unsupported-platform"
  | "missing-launcher"
  | "no-user-manager"
  | "cgroup-v1"
  | "missing-controllers";

export type DelegatedLaunchEligibility =
  | { readonly eligible: true; readonly systemdRun: string; readonly userRuntimeDir: string }
  | { readonly eligible: false; readonly reason: DelegatedScopeIneligibility };

export const systemDelegatedScopeHost: DelegatedScopeHost = {
  uid: () => process.getuid?.(),
  isExecutable: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  exists: existsSync,
  readText: (path) => {
    try {
      return readFileSync(path, "utf8");
    } catch {
      return undefined;
    }
  },
  ownerUid: (path) => {
    try {
      return statSync(path).uid;
    } catch {
      return undefined;
    }
  },
};

const hasRequiredControllers = (controllers: string | undefined): boolean => {
  const available = new Set((controllers ?? "").trim().split(/\s+/u));
  return REQUIRED_CONTROLLERS.every((controller) => available.has(controller));
};

/**
 * Whether the next managed service launch can run in a delegated `systemd-run --user --scope`.
 * A handful of stat/reads: a host `systemd-run` and `env`, the user manager's private socket,
 * the unified cgroup v2 hierarchy, and memory, pids and cpu on `user@<uid>.service`.
 */
export const delegatedLaunchEligibility = (
  platform: HostPlatform,
  host: DelegatedScopeHost,
): DelegatedLaunchEligibility => {
  if (hostPlatformFamily(platform) !== "linux") return { eligible: false, reason: "unsupported-platform" };
  const systemdRun = HOST_SYSTEMD_RUN.find((path) => host.isExecutable(path));
  if (systemdRun === undefined || !host.isExecutable(MANAGED_SCOPE_ENV_BIN))
    return { eligible: false, reason: "missing-launcher" };
  const uid = host.uid();
  const userRuntimeDir = uid === undefined ? undefined : `/run/user/${uid}`;
  if (userRuntimeDir === undefined || !host.exists(`${userRuntimeDir}/systemd/private`))
    return { eligible: false, reason: "no-user-manager" };
  if (!host.exists(`${CGROUP_ROOT}/cgroup.controllers`)) return { eligible: false, reason: "cgroup-v1" };
  const userService = `${CGROUP_ROOT}/user.slice/user-${uid}.slice/user@${uid}.service`;
  if (!hasRequiredControllers(host.readText(`${userService}/cgroup.controllers`)))
    return { eligible: false, reason: "missing-controllers" };
  return { eligible: true, systemdRun, userRuntimeDir };
};

/** The unified-hierarchy cgroup path of a process, e.g. `/user.slice/.../run-p1-i1.scope`. */
export const processCgroupPath = (pid: number, host: DelegatedScopeHost): string | undefined =>
  host
    .readText(`/proc/${pid}/cgroup`)
    ?.split("\n")
    .find((line) => line.startsWith("0::"))
    ?.slice(3)
    .trim();

/**
 * Observed placement of a running service: its cgroup is owned by the user and offers memory,
 * pids and cpu, so Podman can create a cgroup per container beneath it.
 */
export const observeServicePlacement = (pid: number, host: DelegatedScopeHost): ContainerCgroups => {
  const path = processCgroupPath(pid, host);
  if (path === undefined || path === "/" || path.length === 0) return "shared";
  const dir = `${CGROUP_ROOT}${path}`;
  const uid = host.uid();
  if (uid === undefined || host.ownerUid(dir) !== uid) return "shared";
  return hasRequiredControllers(host.readText(`${dir}/cgroup.controllers`)) ? "delegated" : "shared";
};

const restart = "then start the app again.";

/** What the user can do so the next launch gives containers their own cgroups. */
export const delegatedScopeRemediation = (reason: DelegatedScopeIneligibility, user?: string): string => {
  switch (reason) {
    case "unsupported-platform":
      return "The lando provider applies deploy.resources only on Linux for now.";
    case "missing-launcher":
      return `Lando starts its runtime with the host's systemd-run and /usr/bin/env so containers get their own cgroups; install systemd and coreutils, ${restart}`;
    case "no-user-manager":
      return `Lando starts its runtime in a systemd user scope so containers get their own cgroups, and no systemd user manager runs for your user. Enable one with \`loginctl enable-linger ${user ?? "$USER"}\` (or log in through a systemd session), ${restart}`;
    case "cgroup-v1":
      return `This host uses cgroup v1, where containers cannot get their own cgroups without root; boot with the unified cgroup v2 hierarchy (\`systemd.unified_cgroup_hierarchy=1\`), ${restart}`;
    case "missing-controllers":
      return `Your systemd user manager does not delegate the memory, pids and cpu controllers. Create /etc/systemd/system/user@.service.d/delegate.conf with \`[Service]\` and \`Delegate=cpu cpuset io memory pids\`, run \`sudo systemctl daemon-reload\`, log in again, ${restart}`;
  }
};

/** The running service predates delegation and still has running containers, so it is kept. */
export const runningSharedServiceRemediation =
  "The Lando runtime was started without a delegated systemd user scope and still has running containers, so Lando keeps it. Run `lando poweroff`, then start the app again.";
