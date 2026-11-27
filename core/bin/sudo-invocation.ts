/**
 * Refuse `sudo lando ...` when the run would write root-owned files into a user's Lando roots.
 *
 * Running Lando as root through sudo leaves root-owned entries the user's later runs cannot
 * write. Lando asks for administrator access itself when a step needs it, so it refuses before
 * bootstrap when sudo names a non-root invoking user and a resolved root (or the nearest existing
 * ancestor of a missing root) belongs to that user or lies under that user's home. Root-only
 * environments (no `SUDO_UID`, or roots owned by root) keep working.
 *
 * Cold path: only Node built-ins, no Effect or SDK imports.
 * The internal root-ownership repair route runs before this guard.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, sep } from "node:path";

export interface SudoInvocationHost {
  readonly euid: number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Read only when running as root through sudo, so ordinary runs skip root resolution. */
  readonly roots: () => ReadonlyArray<string>;
  readonly ownerOf: (path: string) => number | undefined;
  readonly exists: (path: string) => boolean;
  /** Home directory of a uid from the account database. */
  readonly homeOf: (uid: number) => string | undefined;
}

const within = (parent: string, candidate: string): boolean => {
  const rel = relative(parent, candidate);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
};

const nearestExisting = (path: string, exists: (path: string) => boolean): string => {
  let current = path;
  while (!exists(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
};

export const sudoInvocationMessage = (host: SudoInvocationHost): string | undefined => {
  if (host.euid !== 0) return undefined;
  const raw = host.env.SUDO_UID;
  if (raw === undefined || !/^\d+$/u.test(raw)) return undefined;
  const invokingUid = Number(raw);
  if (invokingUid === 0) return undefined;
  const home = host.homeOf(invokingUid);
  const userRoot = host
    .roots()
    .find(
      (root) =>
        (home !== undefined && within(home, root)) ||
        host.ownerOf(nearestExisting(root, host.exists)) === invokingUid,
    );
  if (userRoot === undefined) return undefined;
  const who = host.env.SUDO_USER ?? `uid ${invokingUid}`;
  return `Lando is running as root through sudo, but its files at ${userRoot} belong to ${who}. Files it wrote there as root would break your later runs. Run lando without sudo: Lando asks for administrator access itself when a step needs it.`;
};

const homeFromPasswd = (uid: number): string | undefined => {
  try {
    for (const line of readFileSync("/etc/passwd", "utf8").split("\n")) {
      const fields = line.split(":");
      if (fields[2] === String(uid)) return fields[5];
    }
  } catch {
    return undefined;
  }
  return undefined;
};

export const systemSudoInvocationHost = (roots: () => ReadonlyArray<string>): SudoInvocationHost => ({
  euid: process.geteuid?.(),
  env: process.env,
  roots,
  ownerOf: (path) => {
    try {
      return statSync(path).uid;
    } catch {
      return undefined;
    }
  },
  exists: existsSync,
  homeOf: homeFromPasswd,
});
