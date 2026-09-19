/**
 * Pure classifier and remediation copy for Traefik file-provider watcher failures.
 * Operates only on already-captured log text; no IO, Effect, or platform reads.
 */

export type WatcherFailureClass = "inotify-limit" | "disk" | "permission" | "other";

export const WATCHER_FAILURE_CLASSES = [
  "inotify-limit",
  "disk",
  "permission",
  "other",
] as const satisfies ReadonlyArray<WatcherFailureClass>;

export const DETAIL_MAX_CHARS = 300;

export type WatcherRemediation = {
  readonly kind: "manual";
  readonly description: string;
  readonly command?: string;
};

const CONTEXT_MARKERS = [
  "*file.provider",
  "error creating file watcher",
  "error adding file watcher",
  "unable to read directory",
] as const;

const hasContextMarker = (lower: string): boolean => CONTEXT_MARKERS.some((marker) => lower.includes(marker));

const truncateDetail = (line: string): string => {
  const trimmed = line.trim();
  if (trimmed.length <= DETAIL_MAX_CHARS) return trimmed;
  return `${trimmed.slice(0, DETAIL_MAX_CHARS - 1)}…`;
};

const classifyLine = (line: string): WatcherFailureClass | undefined => {
  const lower = line.toLowerCase();
  if (!hasContextMarker(lower)) return undefined;

  // 1. EMFILE from fsnotify.NewWatcher (and "in system" variant).
  if (lower.includes("error creating file watcher") && lower.includes("too many open files")) {
    return "inotify-limit";
  }

  // 2. ENOSPC from inotify_add_watch means fs.inotify.max_user_watches is exhausted,
  // NOT that the disk is full. Must run before the directory-read ENOSPC -> disk rule.
  if (lower.includes("error adding file watcher") && lower.includes("no space left on device")) {
    return "inotify-limit";
  }

  // 3. Permission (any context marker, including unable to read directory).
  if (lower.includes("permission denied")) {
    return "permission";
  }

  // 4. Disk health / filesystem errors.
  if (
    lower.includes("input/output error") ||
    lower.includes("read-only file system") ||
    lower.includes("structure needs cleaning")
  ) {
    return "disk";
  }

  // 5. Real disk ENOSPC when reading the directory (not inotify_add_watch).
  if (lower.includes("unable to read directory") && lower.includes("no space left on device")) {
    return "disk";
  }

  // 6. Recognized file-provider context with an unclassified errno.
  return "other";
};

export const classifyWatcherFailure = (
  logText: string,
): { readonly failureClass: WatcherFailureClass; readonly detail: string } | undefined => {
  if (logText.length === 0) return undefined;

  for (const line of logText.split("\n")) {
    const failureClass = classifyLine(line);
    if (failureClass === undefined) continue;
    return {
      failureClass,
      detail: truncateDetail(line),
    };
  }

  return undefined;
};

export const watcherHostLabel = (input: {
  readonly providerId: string;
  readonly platform: "darwin" | "linux" | "win32" | "wsl";
}): string => {
  switch (input.platform) {
    case "linux":
      return "this Linux host";
    case "wsl":
      return "this WSL distribution";
    case "darwin":
    case "win32":
      if (input.providerId === "lando") {
        return "the Lando-managed Podman machine";
      }
      return `the container runtime virtual machine for provider \`${input.providerId}\``;
  }
};

export const watcherRemediations = (
  failureClass: WatcherFailureClass,
  watcherHost: string,
): ReadonlyArray<WatcherRemediation> => {
  switch (failureClass) {
    case "inotify-limit":
      return [
        {
          kind: "manual",
          description: `Reduce what is being watched on ${watcherHost} by stopping other Lando apps or file watchers, then run lando restart.`,
          command: "lando restart",
        },
        {
          kind: "manual",
          description: `Read the current inotify limits on ${watcherHost}.`,
          command: "cat /proc/sys/fs/inotify/max_user_watches /proc/sys/fs/inotify/max_user_instances",
        },
        {
          kind: "manual",
          description: `An administrator can raise the inotify limits on ${watcherHost} with sysctl. Lando never changes sysctl for you.`,
          command: "sysctl fs.inotify.max_user_watches=524288",
        },
      ];
    case "permission":
      return [
        {
          kind: "manual",
          description: `Fix ownership or mode of the Lando proxy config directory on ${watcherHost} as your own user, then run lando restart.`,
          command: "lando restart",
        },
        {
          kind: "manual",
          description: `Verify the runtime user on ${watcherHost} can read the mounted config directory.`,
        },
      ];
    case "disk":
      return [
        {
          kind: "manual",
          description: `Free space or check the filesystem backing the Lando config directory on ${watcherHost}, then run lando restart.`,
          command: "lando restart",
        },
        {
          kind: "manual",
          description: `Inspect disk health on ${watcherHost}.`,
        },
      ];
    case "other":
      return [
        {
          kind: "manual",
          description: `Run lando restart on ${watcherHost}, then re-check with lando doctor.`,
          command: "lando restart",
        },
        {
          kind: "manual",
          description: `Read the captured detail and the Traefik logs on ${watcherHost}.`,
        },
      ];
  }
};
