/**
 * Shared facts about the static in-container helper executable. One Go binary
 * per Linux architecture serves two roles: invoked as `lando` it is the
 * host-proxy client; invoked with a `log-file` subcommand it reads log files
 * for provider file-log follow.
 */

export const CONTAINER_HELPER_FILE = "lando-container-helper";

export type ContainerHelperArch = "x64" | "arm64";

export const CONTAINER_HELPER_ARCHES: ReadonlyArray<ContainerHelperArch> = ["x64", "arm64"];

/** Go `GOARCH` for each helper architecture. */
export const containerHelperGoArch = (arch: ContainerHelperArch): "amd64" | "arm64" =>
  arch === "x64" ? "amd64" : "arm64";

export const logFileHelperExecArgv = (helperPath: string): ReadonlyArray<string> => [helperPath, "log-file"];

export const logFileHelperCleanupArgv = (helperPath: string, directory: string): ReadonlyArray<string> => [
  helperPath,
  "log-file-cleanup",
  directory,
];
