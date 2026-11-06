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

/** Launch record written next to the service pid file; scripts read `.env.XDG_RUNTIME_DIR` from it. */
export const managedLaunchStatePath = (pidPath: string): string => `${pidPath}.launch.json`;
