/**
 * The NSS databases Linux browsers read their certificate trust from. Discovery only reads the
 * filesystem: it never creates a database. Chromium shares one database per user; Firefox keeps one
 * per profile. Snap and Flatpak sandboxes and the system-wide `/etc/pki/nssdb` are out of scope, as
 * are legacy `cert8.db` (DBM) databases, which current browsers no longer read.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";

import type { HostEnv } from "./homebrew-trust.ts";

export interface NssDatabase {
  /** Row name, e.g. `Chrome and Chromium` or `Firefox (default-release)`. */
  readonly name: string;
  /** The browser to close or restart, in prose. */
  readonly browser: string;
  /** The database directory; certutil addresses it as `sql:<dir>`. */
  readonly dir: string;
}

const isDirectory = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isDirectory(),
    () => false,
  );

const isFile = (path: string): Promise<boolean> =>
  stat(path).then(
    (info) => info.isFile(),
    () => false,
  );

/**
 * Chromium (M146 and later) uses `~/.pki/nssdb` when that directory exists and the XDG data
 * directory otherwise; only the one it uses counts.
 */
const chromiumDatabase = async (home: string, env: HostEnv): Promise<NssDatabase | undefined> => {
  const xdgData =
    env.XDG_DATA_HOME !== undefined && isAbsolute(env.XDG_DATA_HOME) ? env.XDG_DATA_HOME : undefined;
  for (const dir of [
    join(home, ".pki", "nssdb"),
    join(xdgData ?? join(home, ".local", "share"), "pki", "nssdb"),
  ]) {
    if (await isDirectory(dir)) return { name: "Chrome and Chromium", browser: "Chrome or Chromium", dir };
  }
  return undefined;
};

interface ProfileEntry {
  readonly name?: string;
  readonly path?: string;
  readonly isRelative: boolean;
}

/** The `[Profile*]` sections of a Firefox `profiles.ini`. */
export const parseProfilesIni = (text: string): ReadonlyArray<ProfileEntry> => {
  const profiles: Array<{ name?: string; path?: string; isRelative: boolean }> = [];
  let current: { name?: string; path?: string; isRelative: boolean } | undefined;
  for (const raw of text.split(/\r?\n/u)) {
    const line = raw.trim();
    const section = /^\[(.+)\]$/u.exec(line);
    if (section !== null) {
      current = section[1]?.startsWith("Profile") === true ? { isRelative: false } : undefined;
      if (current !== undefined) profiles.push(current);
      continue;
    }
    if (current === undefined) continue;
    const separator = line.indexOf("=");
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "Name") current.name = value;
    else if (key === "Path") current.path = value;
    else if (key === "IsRelative") current.isRelative = value === "1";
  }
  return profiles;
};

const firefoxDatabases = async (home: string): Promise<ReadonlyArray<NssDatabase>> => {
  const firefoxDir = join(home, ".mozilla", "firefox");
  const ini = await readFile(join(firefoxDir, "profiles.ini"), "utf8").catch(() => undefined);
  if (ini === undefined) return [];
  const databases: NssDatabase[] = [];
  for (const { name, path, isRelative } of parseProfilesIni(ini)) {
    if (path === undefined || path.length === 0) continue;
    const dir = isRelative ? join(firefoxDir, path) : path;
    if (!isAbsolute(dir) || !(await isFile(join(dir, "cert9.db")))) continue;
    databases.push({ name: `Firefox (${name ?? basename(dir)})`, browser: "Firefox", dir });
  }
  return databases;
};

/** Every browser database for the user whose home is `env.HOME`, each directory once. None off Linux. */
export const discoverNssDatabases = async (
  env: HostEnv,
  platform: string,
): Promise<ReadonlyArray<NssDatabase>> => {
  const home = env.HOME;
  if (platform !== "linux" || home === undefined || !isAbsolute(home)) return [];
  const chromium = await chromiumDatabase(home, env);
  const found = [...(chromium === undefined ? [] : [chromium]), ...(await firefoxDatabases(home))];
  const seen = new Set<string>();
  const unique: NssDatabase[] = [];
  for (const database of found) {
    const real = await realpath(database.dir).catch(() => database.dir);
    if (seen.has(real)) continue;
    seen.add(real);
    unique.push(database);
  }
  return unique;
};
