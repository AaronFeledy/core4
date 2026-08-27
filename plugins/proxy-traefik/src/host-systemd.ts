import { existsSync, readFileSync } from "node:fs";

const HOST_SYSTEMD_RUNTIME = "/run/systemd/system";

export interface HostSystemdProbe {
  readonly exists?: (path: string) => boolean;
  readonly pid1Comm?: string;
  readonly platform?: NodeJS.Platform;
}

const readPid1Comm = (): string => {
  try {
    return readFileSync("/proc/1/comm", "utf8").trim();
  } catch (error) {
    if (error instanceof Error) return "";
    throw error;
  }
};

/** True when this Linux host is running systemd (PID 1 or runtime dir). */
export const hasHostSystemd = (input: HostSystemdProbe = {}): boolean => {
  const platform = input.platform ?? process.platform;
  if (platform !== "linux") return false;
  const exists = input.exists ?? existsSync;
  if (exists(HOST_SYSTEMD_RUNTIME)) return true;
  return (input.pid1Comm ?? readPid1Comm()).trim() === "systemd";
};
