import { isAbsolute, posix, relative, resolve, sep } from "node:path";

/**
 * Pure container→host cwd remapping for the host-proxy `runLando` dispatcher.
 * The dispatcher never trusts a container-provided path: it remaps the container
 * cwd to the host app root using the active mount info, and any path outside the
 * mount collapses to the host app root as the safe default.
 *
 * `HostProxyMountInfo` is the minimal shape needed here; session setup supplies
 * the mount roots when the transport starts.
 */
export interface HostProxyMountInfo {
  /** Absolute container-side app root (e.g. `/app`). */
  readonly containerRoot: string;
  /** Absolute host-side app root the container root maps to. */
  readonly hostRoot: string;
}

const stripTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

const safeRelativePath = (path: string): string | undefined => {
  const normalized = posix.normalize(path);
  if (normalized === ".") return "";
  if (normalized === ".." || normalized.startsWith("../")) return undefined;
  return normalized;
};

/**
 * Remap `containerCwd` to a host-side path under `mount.hostRoot`. A cwd equal
 * to or under `mount.containerRoot` is rebased onto `hostRoot`; anything else
 * (including a sibling prefix like `/application` vs `/app`) falls back to
 * `hostRoot`.
 */
export const remapContainerCwd = (containerCwd: string, mount: HostProxyMountInfo): string => {
  const containerRoot = stripTrailingSlash(posix.normalize(mount.containerRoot));
  const hostRoot = stripTrailingSlash(mount.hostRoot);
  const cwd = stripTrailingSlash(posix.normalize(containerCwd));

  if (cwd === containerRoot) return hostRoot;
  const prefix = `${containerRoot}/`;
  if (cwd.startsWith(prefix)) {
    const relative = safeRelativePath(cwd.slice(prefix.length));
    if (relative === undefined) return hostRoot;
    return relative.length === 0 ? hostRoot : `${hostRoot}/${relative}`;
  }
  return hostRoot;
};

/**
 * Remap a host cwd onto a container path using one bind mount. Returns
 * `undefined` when `hostCwd` is not inside `mount.hostRoot` (including sibling
 * prefixes and parent escapes). A relative `hostCwd` is never a host path
 * (an authored task `dir` or `--cwd web` is container-relative), so it is
 * never resolved against the process cwd.
 */
export const remapHostCwd = (hostCwd: string, mount: HostProxyMountInfo): string | undefined => {
  if (!isAbsolute(hostCwd)) return undefined;
  const hostRoot = resolve(stripTrailingSlash(mount.hostRoot));
  const cwd = resolve(stripTrailingSlash(hostCwd));
  const containerRoot = stripTrailingSlash(posix.normalize(mount.containerRoot));
  if (cwd === hostRoot) return containerRoot;
  const rel = relative(hostRoot, cwd);
  if (rel === "" || rel === ".") return containerRoot;
  if (rel.startsWith("..") || isAbsolute(rel)) return undefined;
  const posixRel = rel.split(sep).join("/");
  const safe = safeRelativePath(posixRel);
  if (safe === undefined) return undefined;
  return safe.length === 0 ? containerRoot : `${containerRoot}/${safe}`;
};

/** Longest host-root prefix wins so nested binds beat the app mount. */
export const tryMapHostCwd = (
  hostCwd: string,
  mounts: ReadonlyArray<HostProxyMountInfo>,
): string | undefined => {
  const ranked = [...mounts].sort(
    (left, right) => resolve(right.hostRoot).length - resolve(left.hostRoot).length,
  );
  for (const mount of ranked) {
    const mapped = remapHostCwd(hostCwd, mount);
    if (mapped !== undefined) return mapped;
  }
  return undefined;
};

type CwdRemapService = {
  readonly appMount?: { readonly source: string; readonly target: string } | undefined;
  readonly mounts: ReadonlyArray<{
    readonly type: string;
    readonly source?: string | undefined;
    readonly target: string;
  }>;
  readonly workingDirectory?: string | undefined;
};

export const bindMountsFromService = (service: CwdRemapService): ReadonlyArray<HostProxyMountInfo> => {
  const mounts: HostProxyMountInfo[] = [];
  if (service.appMount !== undefined) {
    mounts.push({ hostRoot: service.appMount.source, containerRoot: service.appMount.target });
  }
  for (const mount of service.mounts) {
    if (mount.type === "bind" && mount.source !== undefined) {
      mounts.push({ hostRoot: mount.source, containerRoot: mount.target });
    }
  }
  return mounts;
};

/**
 * Resolve the container cwd for `exec` and provider-exec tooling.
 *
 * Precedence:
 * 1. When `explicitCwd` is given, map it through the service bind mounts if it
 *    is an absolute host path under a mount; otherwise keep it verbatim
 *    (authored `dir`, relative paths, container paths, and `--cwd` values that
 *    do not sit on a host root).
 * 2. Otherwise map `hostCwd` (the caller-supplied `process.cwd()`) the same way.
 * 3. If `hostCwd` is not under any bind mount, use `service.appMount.target`,
 *    then `service.workingDirectory`.
 *
 * `hostCwd` is an argument so this helper stays pure and unit-testable.
 */
export const resolveContainerCwd = (
  service: CwdRemapService,
  explicitCwd: string | undefined,
  hostCwd: string,
): string | undefined => {
  const mounts = bindMountsFromService(service);
  if (explicitCwd !== undefined) {
    return tryMapHostCwd(explicitCwd, mounts) ?? explicitCwd;
  }
  return tryMapHostCwd(hostCwd, mounts) ?? service.appMount?.target ?? service.workingDirectory;
};
