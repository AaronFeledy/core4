import { existsSync } from "node:fs";

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
