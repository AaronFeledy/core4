import { existsSync, readFileSync } from "node:fs";

export interface UserSystemdSessionProbe {
  readonly runtimeDir?: string;
  readonly exists?: (path: string) => boolean;
}

export const hasUsableUserSystemdSession = (input: UserSystemdSessionProbe = {}): boolean => {
  const exists = input.exists ?? existsSync;
  const runtimeDir =
    input.runtimeDir ??
    process.env.XDG_RUNTIME_DIR ??
    (typeof process.getuid === "function" ? `/run/user/${String(process.getuid())}` : undefined);
  if (runtimeDir === undefined || runtimeDir.length === 0) return false;
  return exists(`${runtimeDir}/systemd/private`);
};

const HOST_SYSTEMD_RUNTIME = "/run/systemd/system";

export interface HostSystemdProbe {
  readonly exists?: (path: string) => boolean;
  readonly pid1Comm?: string;
}

const readPid1Comm = (): string => {
  try {
    return readFileSync("/proc/1/comm", "utf8").trim();
  } catch {
    return "";
  }
};

/**
 * True when the host PID 1 is systemd or the systemd runtime directory exists.
 * A tini/container PID 1 with no `/run/systemd/system` is not systemd, even if
 * a `systemctl` binary happens to be on PATH.
 */
export const hasHostSystemd = (input: HostSystemdProbe = {}): boolean => {
  const exists = input.exists ?? existsSync;
  if (exists(HOST_SYSTEMD_RUNTIME)) return true;
  const comm = (input.pid1Comm ?? readPid1Comm()).trim();
  return comm === "systemd";
};
