import { lstatSync, realpathSync, statSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readlink, realpath, rm, stat } from "node:fs/promises";
import { basename, isAbsolute, join, resolve } from "node:path";

import { ProviderUnavailableError } from "@lando/sdk/errors";
import { Effect } from "effect";

import { managedLaunchStatePath, privateRuntimeDirName } from "./managed-invocation.ts";

const OWNER_ONLY_MODE = 0o700;
const GROUP_OTHER_BITS = 0o077;
const PAUSE_PID_RELATIVE = join("libpod", "tmp", "pause.pid");
const NS_HANDLES_RELATIVE = join("libpod", "tmp", "ns_handles");

export interface ManagedRuntimeDirStat {
  readonly isDirectory: boolean;
  /** Present on lstat results; absent/false on stat (follows links). */
  readonly isSymbolicLink?: boolean;
  readonly uid: number;
  readonly mode: number;
}

export interface ManagedRuntimeDirFsSeam {
  readonly realpath: (path: string) => Effect.Effect<string, unknown>;
  /** Follows symlinks (base runtime dir candidates). */
  readonly stat: (path: string) => Effect.Effect<ManagedRuntimeDirStat, unknown>;
  /**
   * Does not follow symlinks (private dir identity checks).
   * Optional for resolve-only seams; prepare falls back to the default host lstat.
   */
  readonly lstat?: (path: string) => Effect.Effect<ManagedRuntimeDirStat, unknown>;
  readonly mkdir: (
    path: string,
    options: { readonly recursive: boolean; readonly mode: number },
  ) => Effect.Effect<void, unknown>;
  readonly chmod: (path: string, mode: number) => Effect.Effect<void, unknown>;
}

export interface ManagedRuntimeDirSeams {
  readonly fs?: ManagedRuntimeDirFsSeam;
  readonly getuid?: () => number | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly providerId?: string;
}

export interface ManagedPauseFsSeam {
  readonly readFile: (path: string) => Effect.Effect<string, unknown>;
  readonly unlink: (path: string) => Effect.Effect<void, unknown>;
  readonly readlink: (path: string) => Effect.Effect<string, unknown>;
}

export interface ManagedPauseProcessSeam {
  readonly isAlive: (pid: number) => Effect.Effect<boolean>;
  readonly kill: (pid: number, signal: NodeJS.Signals) => Effect.Effect<void, unknown>;
}

export interface ManagedPauseSeams {
  readonly fs?: ManagedPauseFsSeam;
  readonly process?: ManagedPauseProcessSeam;
  readonly getuid?: () => number | undefined;
}

const defaultGetuid = (): number | undefined => process.getuid?.();

const modeIsOwnerOnly = (mode: number): boolean => (mode & GROUP_OTHER_BITS) === 0;

const toRuntimeDirStat = (info: {
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
  uid: number;
  mode: number;
}): ManagedRuntimeDirStat => ({
  isDirectory: info.isDirectory(),
  isSymbolicLink: info.isSymbolicLink(),
  uid: info.uid,
  mode: info.mode,
});

const defaultManagedRuntimeDirFsSeam = {
  realpath: (path) =>
    Effect.tryPromise({
      try: () => realpath(path),
      catch: (cause) => cause,
    }),
  stat: (path) =>
    Effect.tryPromise({
      try: async () => toRuntimeDirStat(await stat(path)),
      catch: (cause) => cause,
    }),
  lstat: (path) =>
    Effect.tryPromise({
      try: async () => toRuntimeDirStat(await lstat(path)),
      catch: (cause) => cause,
    }),
  mkdir: (path, options) =>
    Effect.tryPromise({
      try: () => mkdir(path, options),
      catch: (cause) => cause,
    }),
  chmod: (path, mode) =>
    Effect.tryPromise({
      try: () => chmod(path, mode),
      catch: (cause) => cause,
    }),
} satisfies ManagedRuntimeDirFsSeam;

/** Rootless preflight has a synchronous probe contract; service builders never use this seam. */
export const synchronousManagedRuntimeDirFsSeam: ManagedRuntimeDirFsSeam = {
  ...defaultManagedRuntimeDirFsSeam,
  realpath: (path) => Effect.try({ try: () => realpathSync(path), catch: (cause) => cause }),
  stat: (path) =>
    Effect.try({
      try: () => toRuntimeDirStat(statSync(path)),
      catch: (cause) => cause,
    }),
  lstat: (path) =>
    Effect.try({
      try: () => toRuntimeDirStat(lstatSync(path)),
      catch: (cause) => cause,
    }),
};

const defaultManagedPauseFsSeam: ManagedPauseFsSeam = {
  readFile: (path) =>
    Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause,
    }),
  unlink: (path) =>
    Effect.tryPromise({
      try: () => rm(path, { force: true, recursive: true }),
      catch: (cause) => cause,
    }),
  readlink: (path) =>
    Effect.tryPromise({
      try: () => readlink(path),
      catch: (cause) => cause,
    }),
};

const defaultManagedPauseProcessSeam: ManagedPauseProcessSeam = {
  isAlive: (pid) =>
    Effect.sync(() => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    }),
  kill: (pid, signal) =>
    Effect.try({
      try: () => {
        process.kill(pid, signal);
      },
      catch: (cause) => cause,
    }),
};

const isUsableRuntimeBase = (info: ManagedRuntimeDirStat, uid: number): boolean =>
  info.isDirectory && info.isSymbolicLink !== true && info.uid === uid && modeIsOwnerOnly(info.mode);

/**
 * Resolve the private runtime dir path without creating it. Undefined when no
 * usable base (`/run/user/<uid>` preferred, else owner-only `XDG_RUNTIME_DIR`).
 */
export const resolveManagedRuntimeDir = Effect.fnUntraced(function* (
  runtimeDir: string,
  seams: ManagedRuntimeDirSeams = {},
): Effect.fn.Return<string | undefined> {
  const fsSeam = seams.fs ?? defaultManagedRuntimeDirFsSeam;
  const getuid = seams.getuid ?? defaultGetuid;
  const env = seams.env ?? process.env;
  const uid = getuid();
  if (uid === undefined) return undefined;

  // realpath preferred; unresolved paths still need a stable hash key.
  const canonical = yield* fsSeam
    .realpath(runtimeDir)
    .pipe(Effect.catch(() => Effect.succeed(resolve(runtimeDir))));

  const candidates = [`/run/user/${uid}`, env.XDG_RUNTIME_DIR];
  for (const candidate of candidates) {
    if (typeof candidate !== "string" || candidate.length === 0) continue;
    const info = yield* fsSeam.stat(candidate).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (info === undefined || !isUsableRuntimeBase(info, uid)) continue;
    return join(candidate, privateRuntimeDirName(canonical));
  }
  return undefined;
});

const recordedXdgRuntimeDir = (launchState: string): string | undefined => {
  try {
    const parsed: unknown = JSON.parse(launchState);
    if (typeof parsed !== "object" || parsed === null || !("env" in parsed)) return undefined;
    const env = parsed.env;
    if (typeof env !== "object" || env === null || !("XDG_RUNTIME_DIR" in env)) return undefined;
    return typeof env.XDG_RUNTIME_DIR === "string" ? env.XDG_RUNTIME_DIR : undefined;
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
};

/**
 * The private runtime dir a launched service actually used, falling back to the current resolution.
 * Teardown must find the pause process where the service put it even if the session's runtime base
 * changed since launch. The record is trusted only when its name matches this runtime dir.
 */
export const managedRuntimeDirForTeardown = (
  runtimeDir: string,
  seams: ManagedRuntimeDirSeams & {
    readonly readFile?: (path: string) => Effect.Effect<string, unknown>;
  } = {},
): Effect.Effect<string | undefined> =>
  Effect.gen(function* () {
    const fsSeam = seams.fs ?? defaultManagedRuntimeDirFsSeam;
    const read = seams.readFile ?? defaultManagedPauseFsSeam.readFile;
    const launchState = yield* read(managedLaunchStatePath(join(runtimeDir, "run", "podman.pid"))).pipe(
      Effect.catch(() => Effect.succeed(undefined)),
    );
    const recorded = launchState === undefined ? undefined : recordedXdgRuntimeDir(launchState);
    if (recorded !== undefined && isAbsolute(recorded)) {
      const canonical = yield* fsSeam
        .realpath(runtimeDir)
        .pipe(Effect.catch(() => Effect.succeed(resolve(runtimeDir))));
      if (basename(recorded) === privateRuntimeDirName(canonical)) return recorded;
    }
    return yield* resolveManagedRuntimeDir(runtimeDir, seams);
  });

const privateRuntimeDirUnavailable = (providerId: string, cause?: unknown): ProviderUnavailableError =>
  new ProviderUnavailableError({
    providerId,
    operation: "setup",
    message: "Rootless Podman requires a private runtime directory base for your session.",
    remediation:
      "Ensure /run/user/$(id -u) exists, is owned by your user, and has mode 0700 (no group/other bits), or export XDG_RUNTIME_DIR to a directory with the same properties, then rerun `lando setup`.",
    details: { prerequisite: "xdg-runtime-dir" },
    cause,
  });

const isSafeOwnedDirectory = (info: ManagedRuntimeDirStat, uid: number): boolean =>
  info.isSymbolicLink !== true && info.isDirectory && info.uid === uid;

/**
 * Create (0700) and verify the private runtime dir under a usable base.
 * Fails closed with the rootless xdg-runtime-dir prerequisite shape when no base exists.
 *
 * Never chmods a foreign-owned path or follows a private-dir symlink: owner and
 * non-symlink checks run via lstat before chmod.
 */
export const prepareManagedRuntimeDir = (
  runtimeDir: string,
  seams: ManagedRuntimeDirSeams = {},
  resolved?: { readonly privateRuntimeDir: string | undefined },
): Effect.Effect<string, ProviderUnavailableError> =>
  Effect.gen(function* () {
    const providerId = seams.providerId ?? "lando";
    const fsSeam = seams.fs ?? defaultManagedRuntimeDirFsSeam;
    const lstatPath = fsSeam.lstat ?? defaultManagedRuntimeDirFsSeam.lstat;
    const getuid = seams.getuid ?? defaultGetuid;
    const uid = getuid();
    if (uid === undefined) {
      return yield* Effect.fail(privateRuntimeDirUnavailable(providerId));
    }

    const privateDir =
      resolved === undefined
        ? yield* resolveManagedRuntimeDir(runtimeDir, seams)
        : resolved.privateRuntimeDir;
    if (privateDir === undefined) {
      return yield* Effect.fail(privateRuntimeDirUnavailable(providerId));
    }

    const existing = yield* lstatPath(privateDir).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (existing !== undefined) {
      if (!isSafeOwnedDirectory(existing, uid)) {
        return yield* Effect.fail(privateRuntimeDirUnavailable(providerId));
      }
    } else {
      yield* fsSeam
        .mkdir(privateDir, { recursive: true, mode: OWNER_ONLY_MODE })
        .pipe(Effect.mapError((cause) => privateRuntimeDirUnavailable(providerId, cause)));
      const created = yield* lstatPath(privateDir).pipe(
        Effect.mapError((cause) => privateRuntimeDirUnavailable(providerId, cause)),
      );
      if (!isSafeOwnedDirectory(created, uid)) {
        return yield* Effect.fail(privateRuntimeDirUnavailable(providerId));
      }
    }

    yield* fsSeam
      .chmod(privateDir, OWNER_ONLY_MODE)
      .pipe(Effect.mapError((cause) => privateRuntimeDirUnavailable(providerId, cause)));

    const info = yield* lstatPath(privateDir).pipe(
      Effect.mapError((cause) => privateRuntimeDirUnavailable(providerId, cause)),
    );
    if (!isUsableRuntimeBase(info, uid)) {
      return yield* Effect.fail(privateRuntimeDirUnavailable(providerId));
    }
    return privateDir;
  });

const parsePausePid = (raw: string): number | undefined => {
  const trimmed = raw.trim();
  if (!/^\d+$/u.test(trimmed)) return undefined;
  const pid = Number(trimmed);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
};

const parseProcStatusUid = (status: string): number | undefined => {
  const match = status.match(/^Uid:\s+(\d+)/mu);
  if (match?.[1] === undefined) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
};

/**
 * Terminate the rootless pause process owned by this private runtime dir only.
 * Fail-safe: skips kill when the pid is missing, dead, wrong uid, or shares our user ns.
 * Identity uses `/proc/<pid>/status` Uid (real uid), not `/proc/<pid>` stat.
 */
export const terminateManagedPause = (
  privateRuntimeDir: string,
  seams: ManagedPauseSeams = {},
): Effect.Effect<void> =>
  Effect.gen(function* () {
    const fsSeam = seams.fs ?? defaultManagedPauseFsSeam;
    const processSeam = seams.process ?? defaultManagedPauseProcessSeam;
    const getuid = seams.getuid ?? defaultGetuid;
    const uid = getuid();
    if (uid === undefined) return;

    const pausePidPath = join(privateRuntimeDir, PAUSE_PID_RELATIVE);
    const nsHandlesPath = join(privateRuntimeDir, NS_HANDLES_RELATIVE);

    const rawPid = yield* fsSeam.readFile(pausePidPath).pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (rawPid === undefined) {
      yield* fsSeam.unlink(nsHandlesPath).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const pid = parsePausePid(rawPid);
    if (pid === undefined) {
      yield* fsSeam.unlink(pausePidPath).pipe(Effect.catch(() => Effect.void));
      yield* fsSeam.unlink(nsHandlesPath).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const alive = yield* processSeam.isAlive(pid);
    if (!alive) {
      yield* fsSeam.unlink(pausePidPath).pipe(Effect.catch(() => Effect.void));
      yield* fsSeam.unlink(nsHandlesPath).pipe(Effect.catch(() => Effect.void));
      return;
    }

    const status = yield* fsSeam
      .readFile(`/proc/${pid}/status`)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    if (status === undefined) return;
    const processUid = parseProcStatusUid(status);
    if (processUid === undefined || processUid !== uid) return;

    const ourNs = yield* fsSeam
      .readlink("/proc/self/ns/user")
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const theirNs = yield* fsSeam
      .readlink(`/proc/${pid}/ns/user`)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    // Only kill a pause that lives in a different user namespace (rootless pause).
    // Same ns means the pid was reused by a process in our namespace, so leave it.
    if (ourNs === undefined || theirNs === undefined || ourNs === theirNs) return;

    // Podman's pause keeps the environment of the process that created it. Requiring this private dir
    // there rejects another data root's or system Podman's pause that reused a stale pid.
    const environ = yield* fsSeam
      .readFile(`/proc/${pid}/environ`)
      .pipe(Effect.catch(() => Effect.succeed(undefined)));
    const variables = environ?.split("\0") ?? [];
    if (
      !variables.includes("_PODMAN_PAUSE=1") ||
      !variables.includes(`XDG_RUNTIME_DIR=${privateRuntimeDir}`)
    ) {
      return;
    }

    const signaled = yield* processSeam.kill(pid, "SIGKILL").pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (!signaled) return;
    yield* fsSeam.unlink(pausePidPath).pipe(Effect.catch(() => Effect.void));
    yield* fsSeam.unlink(nsHandlesPath).pipe(Effect.catch(() => Effect.void));
  });
