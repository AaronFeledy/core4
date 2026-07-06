/**
 * Pure container→host cwd remapping for the host-proxy `runLando` dispatcher
 * (§10.10.4). The dispatcher never trusts a container-provided path: it remaps
 * the container cwd to the host app root using the active mount info, and any
 * path outside the mount collapses to the host app root as the safe default.
 *
 * `HostProxyMountInfo` is the minimal shape needed here; the full §6.4
 * `AppMountInfo` wiring that populates it belongs to the physical host-proxy
 * subsystem wave.
 */
export interface HostProxyMountInfo {
  /** Absolute container-side app root (e.g. `/app`). */
  readonly containerRoot: string;
  /** Absolute host-side app root the container root maps to. */
  readonly hostRoot: string;
}

const stripTrailingSlash = (path: string): string =>
  path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;

/**
 * Remap `containerCwd` to a host-side path under `mount.hostRoot`. A cwd equal
 * to or under `mount.containerRoot` is rebased onto `hostRoot`; anything else
 * (including a sibling prefix like `/application` vs `/app`) falls back to
 * `hostRoot`.
 */
export const remapContainerCwd = (containerCwd: string, mount: HostProxyMountInfo): string => {
  const containerRoot = stripTrailingSlash(mount.containerRoot);
  const hostRoot = stripTrailingSlash(mount.hostRoot);
  const cwd = stripTrailingSlash(containerCwd);

  if (cwd === containerRoot) return hostRoot;
  const prefix = `${containerRoot}/`;
  if (cwd.startsWith(prefix)) {
    const relative = cwd.slice(prefix.length);
    return `${hostRoot}/${relative}`;
  }
  return hostRoot;
};
