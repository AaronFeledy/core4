import { createHash } from "node:crypto";
import { delimiter } from "node:path";

/** Linux `sockaddr_un.sun_path` cap for a plain net.Listen API socket. */
export const MANAGED_SOCKET_PATH_MAX_BYTES = 107;

const PRIVATE_RUNTIME_DIR_PREFIX = "lando-";
const PRIVATE_RUNTIME_HASH_HEX_LENGTH = 16;

const HOST_ENV_ALLOWLIST = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LANGUAGE",
  "TZ",
  "TMPDIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "REGISTRY_AUTH_FILE",
  "DOCKER_CONFIG",
]);

const PODMAN_REDIRECT_DENYLIST = new Set([
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
  "CONTAINER_PASSPHRASE",
  "CONTAINER_PROXY",
  "PODMAN_CONNECTIONS_CONF",
  "CONTAINERS_CONF_OVERRIDE",
  "_PODMAN_PAUSE",
  "PODMAN_NO_PAUSE_PROCESS",
  "_CONTAINERS_USERNS_CONFIGURED",
  "_CONTAINERS_ROOTLESS_UID",
  "_CONTAINERS_ROOTLESS_GID",
]);

export interface ManagedPodmanGlobalArgsParts {
  readonly runtimeStorageDir: string;
  readonly runtimeRunDir: string;
  readonly runtimeConfigDir: string;
  readonly runtimeBinDir?: string;
}

export interface ManagedPodmanOverlayEnvParts {
  readonly runtimeConfigDir: string;
  readonly runtimeBinDir?: string;
  readonly privateRuntimeDir?: string;
  readonly hostPath?: string;
}

export const privateRuntimeDirName = (canonicalRuntimeDir: string): string => {
  const digest = createHash("sha256").update(canonicalRuntimeDir).digest("hex");
  return `${PRIVATE_RUNTIME_DIR_PREFIX}${digest.slice(0, PRIVATE_RUNTIME_HASH_HEX_LENGTH)}`;
};

export const managedSocketPathByteLength = (socketPath: string): number =>
  Buffer.byteLength(socketPath, "utf8");

export const managedPodmanGlobalArgs = (parts: ManagedPodmanGlobalArgsParts): ReadonlyArray<string> => {
  const storageOptions =
    parts.runtimeBinDir === undefined
      ? []
      : ["--storage-opt", `overlay.mount_program=${parts.runtimeBinDir}/fuse-overlayfs`];

  return [
    "--root",
    parts.runtimeStorageDir,
    "--runroot",
    parts.runtimeRunDir,
    "--config",
    parts.runtimeConfigDir,
    ...storageOptions,
  ];
};

/**
 * Persisted launch identity for the managed Linux service. Host PATH after the
 * runtime bin is not identity (prefix comparison only); host values otherwise
 * never land in podman.pid.launch.json.
 */
export const managedPodmanOverlayEnv = (
  parts: ManagedPodmanOverlayEnvParts,
): Readonly<Record<string, string>> => {
  const hostPath = parts.hostPath ?? "";
  const pathValue =
    parts.runtimeBinDir === undefined
      ? hostPath.length > 0
        ? hostPath
        : undefined
      : hostPath.length === 0
        ? parts.runtimeBinDir
        : `${parts.runtimeBinDir}${delimiter}${hostPath}`;

  return {
    CONTAINERS_CONF: `${parts.runtimeConfigDir}/containers.conf`,
    CONTAINERS_REGISTRIES_CONF: `${parts.runtimeConfigDir}/registries.conf`,
    XDG_CONFIG_HOME: parts.runtimeConfigDir,
    DISABLE_HC_SYSTEMD: "true",
    LANDO_MANAGED_CONFIG_REVISION: "2-native-init",
    ...(parts.privateRuntimeDir === undefined ? {} : { XDG_RUNTIME_DIR: parts.privateRuntimeDir }),
    ...(pathValue === undefined ? {} : { PATH: pathValue }),
  };
};

export const managedPodmanChildEnv = (
  overlay: Readonly<Record<string, string>>,
  hostEnv: Readonly<Record<string, string | undefined>> = process.env,
): Readonly<Record<string, string>> => {
  const child: Record<string, string> = {};
  for (const [key, value] of Object.entries(hostEnv)) {
    if (value === undefined || !(HOST_ENV_ALLOWLIST.has(key) || key.startsWith("LC_"))) continue;
    child[key] = value;
  }
  return { ...child, ...overlay };
};

/**
 * Drop Podman/container redirect and pause-control variables for macOS/Windows
 * `podman machine` / `--connection` CLI spawns. Does not apply Linux XDG/config overlay.
 */
export const withoutPodmanRedirectsDefined = (
  env: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const cleaned: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined || PODMAN_REDIRECT_DENYLIST.has(key)) continue;
    cleaned[key] = value;
  }
  return cleaned;
};

/** Host `env` that restores the private runtime dir between the scope launcher and Podman. */
export const MANAGED_SCOPE_ENV_BIN = "/usr/bin/env";
const MANAGED_SCOPE_DESCRIPTION = "Lando managed Podman runtime";

/** A delegated user-scope launch of the managed service on Linux. */
export interface ManagedPodmanScopeLaunch {
  /** Absolute host `systemd-run`, never the runtime-bin shim. */
  readonly systemdRun: string;
  /** Pass `--expand-environment=no` (systemd 254+) so `$` in data-root paths is never expanded. */
  readonly expandEnvironmentFlag: boolean;
  readonly privateRuntimeDir: string;
}

/**
 * `systemd-run --user --scope` registers its own PID in a delegated scope and then execs the
 * command, so the launched PID becomes `env`, then Podman with exactly `podmanArgv`.
 */
export const managedPodmanScopeArgv = (
  launch: ManagedPodmanScopeLaunch,
  podmanArgv: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  launch.systemdRun,
  "--user",
  "--scope",
  "--quiet",
  "--collect",
  "-p",
  "Delegate=yes",
  ...(launch.expandEnvironmentFlag ? ["--expand-environment=no"] : []),
  `--description=${MANAGED_SCOPE_DESCRIPTION}`,
  "--",
  MANAGED_SCOPE_ENV_BIN,
  `XDG_RUNTIME_DIR=${launch.privateRuntimeDir}`,
  ...podmanArgv,
];

/**
 * Environment for the scope launcher: the managed child env with the user's real runtime dir, so
 * `systemd-run` reaches the manager through `<dir>/systemd/private`. No D-Bus address is added.
 */
export const managedPodmanScopeLauncherEnv = (
  childEnv: Readonly<Record<string, string>>,
  userRuntimeDir: string,
): Readonly<Record<string, string>> => ({ ...childEnv, XDG_RUNTIME_DIR: userRuntimeDir });

const sameArgv = (actual: ReadonlyArray<string>, expected: ReadonlyArray<string>): boolean =>
  actual.length === expected.length && actual.every((arg, index) => arg === expected[index]);

/**
 * Whether `actual` is the managed service at any exec stage of its launch: the scope launcher,
 * the `env` that follows it, or Podman itself. The launched PID passes through all three, so
 * ownership checks that run before the exec chain completes still recognize it.
 */
export const isManagedPodmanLaunchStage = (
  actual: ReadonlyArray<string>,
  podmanArgv: ReadonlyArray<string>,
  privateRuntimeDir?: string,
): boolean => {
  if (sameArgv(actual, podmanArgv)) return true;
  const envIndex = actual.indexOf(MANAGED_SCOPE_ENV_BIN);
  if (envIndex < 0 || !sameArgv(actual.slice(envIndex + 2), podmanArgv)) return false;
  const assignment = actual[envIndex + 1] ?? "";
  if (
    privateRuntimeDir === undefined
      ? !assignment.startsWith("XDG_RUNTIME_DIR=")
      : assignment !== `XDG_RUNTIME_DIR=${privateRuntimeDir}`
  )
    return false;
  if (envIndex === 0) return true;
  const launcher = actual[0] ?? "";
  return (
    actual[envIndex - 1] === "--" &&
    launcher.startsWith("/") &&
    launcher.endsWith("/systemd-run") &&
    actual.slice(1, envIndex).includes("--scope")
  );
};

/** Launch record written next to the service pid file; scripts read `.env.XDG_RUNTIME_DIR` from it. */
export const managedLaunchStatePath = (pidPath: string): string => `${pidPath}.launch.json`;
