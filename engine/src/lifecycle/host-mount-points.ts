/**
 * Host-side mount-point preparation.
 *
 * A provider creates a missing container directory as the container user. Under
 * a user-namespace mapping that user is not the host user, so a directory the
 * runtime creates inside the app bind (the working directory, an exclude
 * shadow, a nested mount point) belongs to an identity neither the host user
 * nor the project user can write. The runtime cannot create the app root's
 * missing children correctly, so Lando creates them itself, as the host user,
 * before provider apply creates the service containers.
 *
 * Only directories are prepared: a working directory below the app mount, every
 * directory mount point below it, and the parent directories of a file mount
 * point, whose target itself is left to the runtime. Paths map through the app
 * bind's host source and
 * stay inside the canonical app root; `..` and a symlink that leaves the root
 * are refused, existing paths are never modified, and a bind source the CLI
 * cannot see (an accelerated or remote mount) is a no-op.
 */
import { lstat, mkdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, posix, sep } from "node:path";

import { isErrnoCode, safeFileIoError } from "@lando/sdk/errors";
import type { AppPlan, BindMountPlan, MountPlan } from "@lando/sdk/schema";
import { Context, Effect, Layer } from "effect";

/** The parts of a planned service this module reads. */
export interface HostMountService {
  readonly name: string;
  readonly workingDirectory?: string | undefined;
  readonly mounts: ReadonlyArray<MountPlan>;
}

/** One directory the runtime would create inside the app bind, mapped onto the host. */
export interface HostMountDirectory {
  readonly service: string;
  /** Container directory whose absence the runtime would otherwise create. */
  readonly target: string;
  /** Host source of the service's app bind. */
  readonly root: string;
  /** Path below `root`, in order. */
  readonly segments: ReadonlyArray<string>;
  /** The host path the directory occupies. */
  readonly path: string;
  /** The nested mount that owns the directory; absent for the working directory. */
  readonly mount?: MountPlan;
}

const appBindOf = (mounts: ReadonlyArray<MountPlan>): BindMountPlan | undefined =>
  mounts.find((mount): mount is BindMountPlan => mount.type === "bind" && mount.role === "app");

/**
 * Path segments for a container directory strictly below the app mount.
 *
 * Anything outside the app mount, the app mount itself, an absolute
 * container path, and any `..` segment is refused.
 */
export const appRelativeSegments = (appTarget: string, target: string): ReadonlyArray<string> | undefined => {
  const relative = posix.relative(appTarget, target);
  if (relative === "" || relative === "." || posix.isAbsolute(relative)) return undefined;
  const segments = relative.split("/");
  return segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ? undefined
    : segments;
};

const inside = (root: string, candidate: string): boolean =>
  candidate === root || candidate.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

/**
 * The host directories a plan needs before its service containers are created.
 *
 * A service without a passthrough app bind contributes nothing: an accelerated
 * app mount is a file-sync volume, and a provider whose bind source is not a
 * host path the CLI can see is handled by the executor's unavailable-root
 * check.
 */
export const hostMountDirectories = (
  services: ReadonlyArray<HostMountService>,
): ReadonlyArray<HostMountDirectory> => {
  const seen = new Set<string>();
  const directories: HostMountDirectory[] = [];
  for (const service of services) {
    const bind = appBindOf(service.mounts);
    if (bind === undefined || bind.realization !== "passthrough" || !isAbsolute(bind.source)) continue;
    const candidates: ReadonlyArray<{ readonly target: string; readonly mount?: MountPlan }> = [
      ...(service.workingDirectory === undefined ? [] : [{ target: service.workingDirectory }]),
      ...service.mounts.map((mount) => ({ target: mount.target, mount })),
    ];
    for (const candidate of candidates) {
      const segments = appRelativeSegments(bind.target, candidate.target);
      if (segments === undefined) continue;
      const path = join(bind.source, ...segments);
      if (!inside(bind.source, path) || seen.has(path)) continue;
      seen.add(path);
      directories.push({
        service: service.name,
        target: candidate.target,
        root: bind.source,
        segments,
        path,
        ...(candidate.mount === undefined ? {} : { mount: candidate.mount }),
      });
    }
  }
  return directories;
};

const canonicalDirectory = (path: string) =>
  Effect.tryPromise({
    try: async () => {
      try {
        return await realpath(path);
      } catch (cause) {
        // An unavailable bind source (an accelerated or remote provider) is a no-op.
        if (isErrnoCode(cause, "ENOENT") || isErrnoCode(cause, "ENOTDIR")) return undefined;
        throw cause;
      }
    },
    catch: (cause) => safeFileIoError("persist", path, cause),
  });

const lstatOrUndefined = async (path: string) => {
  try {
    return await lstat(path);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT") || isErrnoCode(cause, "ENOTDIR")) return undefined;
    throw cause;
  }
};

const statOrUndefined = async (path: string) => {
  try {
    return await stat(path);
  } catch (cause) {
    if (isErrnoCode(cause, "ENOENT") || isErrnoCode(cause, "ENOTDIR") || isErrnoCode(cause, "ELOOP"))
      return undefined;
    throw cause;
  }
};

/** The segments to create: a file bind's target is never created, only the directories above it. */
const segmentsToCreate = async (directory: HostMountDirectory): Promise<ReadonlyArray<string>> => {
  const mount = directory.mount;
  if (mount === undefined || mount.type !== "bind" || mount.realization === "accelerated")
    return directory.segments;
  const source = await statOrUndefined(mount.source);
  return source === undefined || source.isDirectory() ? directory.segments : directory.segments.slice(0, -1);
};

/**
 * Creates every missing segment below `root`.
 *
 * An existing directory is left untouched. A symlink is followed only while it
 * still resolves inside `root`, and a path that names anything other than a
 * directory stops the walk instead of being replaced.
 */
const createDirectory = async (root: string, segments: ReadonlyArray<string>): Promise<void> => {
  let current = root;
  for (const segment of segments) {
    const next = join(current, segment);
    const info = await lstatOrUndefined(next);
    if (info === undefined) {
      try {
        await mkdir(next);
      } catch (cause) {
        if (!isErrnoCode(cause, "EEXIST")) throw cause;
      }
      current = next;
      continue;
    }
    if (info.isSymbolicLink()) {
      const resolved = await realpath(next).catch((cause: unknown) => {
        if (isErrnoCode(cause, "ENOENT") || isErrnoCode(cause, "ELOOP")) return undefined;
        throw cause;
      });
      if (resolved === undefined || !inside(root, resolved)) return;
      const followed = await statOrUndefined(next);
      if (followed === undefined || !followed.isDirectory()) return;
      current = next;
      continue;
    }
    if (!info.isDirectory()) return;
    current = next;
  }
};

export const prepareHostMountPoints = Effect.fn("HostMountPoints.prepare")(function* (
  plan: Pick<AppPlan, "services">,
) {
  const directories = hostMountDirectories(Object.values(plan.services));
  if (directories.length === 0) return;
  const roots = new Map<string, string | undefined>();
  for (const directory of directories) {
    if (!roots.has(directory.root)) roots.set(directory.root, yield* canonicalDirectory(directory.root));
    const root = roots.get(directory.root);
    if (root === undefined) continue;
    const segments = yield* Effect.tryPromise({
      try: () => segmentsToCreate(directory),
      catch: (cause) => safeFileIoError("persist", directory.path, cause),
    });
    if (segments.length === 0) continue;
    yield* Effect.tryPromise({
      try: () => createDirectory(root, segments),
      catch: (cause) => safeFileIoError("persist", directory.path, cause),
    });
  }
});

/** Host directory preparation required before a plan's service containers are created. */
export class HostMountPoints extends Context.Service<
  HostMountPoints,
  {
    readonly prepare: (
      plan: Pick<AppPlan, "services">,
    ) => Effect.Effect<void, ReturnType<typeof safeFileIoError>>;
  }
>()("@lando/engine/HostMountPoints") {
  static readonly layer = Layer.succeed(
    HostMountPoints,
    HostMountPoints.of({ prepare: prepareHostMountPoints }),
  );
}
