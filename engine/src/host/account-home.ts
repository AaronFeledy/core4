/**
 * An account's home directory by uid, the one answer setup's planner and the root-owned walker
 * share. It asks the system's account database through `getent passwd <uid>`, so directory
 * accounts (LDAP, sssd) resolve as they do for login, and falls back to `/etc/passwd` when no
 * `getent` runs. It never reads `HOME`, and it runs `getent` by absolute path with argv only, no
 * shell, and an empty environment, so it is safe in the walker that runs as root.
 */
import { existsSync, readFileSync } from "node:fs";

const GETENT_PATHS = ["/usr/bin/getent", "/bin/getent"] as const;

export interface AccountHomeHost {
  readonly exists: (path: string) => boolean;
  /** Runs `argv` and returns its stdout, or undefined when it did not exit 0. */
  readonly run: (argv: readonly [string, ...string[]]) => string | undefined;
  readonly readPasswd: () => string | undefined;
}

const systemHost: AccountHomeHost = {
  exists: existsSync,
  run: (argv) => {
    const child = Bun.spawnSync([...argv], { env: {}, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    return child.exitCode === 0 ? child.stdout.toString() : undefined;
  },
  readPasswd: () => {
    try {
      return readFileSync("/etc/passwd", "utf8");
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      return undefined;
    }
  },
};

/** The home field of the passwd line for `uid`, when the text holds one. */
const homeIn = (passwd: string, uid: number): string | undefined => {
  for (const line of passwd.split("\n")) {
    const fields = line.split(":");
    if (fields.length >= 7 && fields[2] === String(uid) && fields[5] !== undefined && fields[5].length > 0)
      return fields[5];
  }
  return undefined;
};

export const homeOfUid = (uid: number, host: AccountHomeHost = systemHost): string | undefined => {
  if (!Number.isSafeInteger(uid) || uid < 0) return undefined;
  const getent = GETENT_PATHS.find((path) => host.exists(path));
  const listed = getent === undefined ? undefined : host.run([getent, "passwd", String(uid)]);
  if (listed !== undefined) return homeIn(listed, uid);
  const passwd = host.readPasswd();
  return passwd === undefined ? undefined : homeIn(passwd, uid);
};
