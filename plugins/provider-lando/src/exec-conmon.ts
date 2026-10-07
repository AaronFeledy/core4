import { readFile, readdir } from "node:fs/promises";

import { Effect } from "effect";

/**
 * Podman's default `exit_command_delay` is 300s. With `cgroups = "no-conmon"`,
 * `conmon --exec-attach` double-forks to init and is not in the container
 * cgroup, so removing the container does not signal it. The monitor keeps the
 * deleted container's name until that delay elapses.
 * Runtime stop reaps only exec monitors whose container monitor is gone.
 */
export interface ExecConmonProcess {
  readonly pid: number;
  readonly argv: ReadonlyArray<string>;
}

export interface ExecConmonReaper {
  readonly listArgv: Effect.Effect<ReadonlyArray<ExecConmonProcess>, unknown>;
  readonly kill: (pid: number) => Effect.Effect<void, unknown>;
}

export interface ExecConmonSelector {
  readonly names?: ReadonlySet<string>;
  readonly containerIds?: ReadonlySet<string>;
}

const flagValue = (argv: ReadonlyArray<string>, flag: string): string | undefined => {
  const index = argv.indexOf(flag);
  if (index < 0 || index + 1 >= argv.length) return undefined;
  return argv[index + 1];
};

export const managedConmonPath = (runtimeBinDir: string): string =>
  `${runtimeBinDir.replace(/[/\\]+$/u, "")}/conmon`;

export const managedConmonPathForPodman = (podmanCommand: string): string => {
  const slash = Math.max(podmanCommand.lastIndexOf("/"), podmanCommand.lastIndexOf("\\"));
  const directory = slash < 0 ? "" : podmanCommand.slice(0, slash + 1);
  return `${directory}conmon`;
};

const isExecAttachArgv = (argv: ReadonlyArray<string>): boolean =>
  argv.includes("--exec-attach") || argv.includes("--exec-process-spec");

const containerIdMatches = (argvId: string, containerIds: ReadonlySet<string>): boolean => {
  for (const containerId of containerIds) {
    if (containerId.length >= 12 && (argvId === containerId || argvId.startsWith(containerId))) return true;
  }
  return false;
};

export const isLingeringExecConmon = (
  argv: ReadonlyArray<string>,
  conmonPath: string,
  selector?: ExecConmonSelector,
  liveContainerIds: ReadonlySet<string> = new Set(),
): boolean => {
  const command = argv[0];
  if (command !== conmonPath || !isExecAttachArgv(argv)) return false;
  if (selector?.names === undefined && selector?.containerIds === undefined) {
    const containerId = flagValue(argv, "-c");
    return containerId !== undefined && !liveContainerIds.has(containerId);
  }
  const name = flagValue(argv, "-n");
  if (selector.names !== undefined && name !== undefined && selector.names.has(name)) return true;
  const containerId = flagValue(argv, "-c");
  return (
    selector.containerIds !== undefined &&
    containerId !== undefined &&
    containerIdMatches(containerId, selector.containerIds)
  );
};

const readProcessArgv = async (pid: number): Promise<ReadonlyArray<string> | undefined> => {
  try {
    const raw = await readFile(`/proc/${pid}/cmdline`);
    const argv = raw
      .toString("utf8")
      .split("\0")
      .filter((part) => part.length > 0);
    return argv.length === 0 ? undefined : argv;
  } catch {
    return undefined;
  }
};

export const hostExecConmonReaper: ExecConmonReaper = {
  listArgv: Effect.tryPromise({
    try: async () => {
      const entries = await readdir("/proc");
      const processes: ExecConmonProcess[] = [];
      for (const entry of entries) {
        if (!/^\d+$/u.test(entry)) continue;
        const pid = Number(entry);
        const argv = await readProcessArgv(pid);
        if (argv !== undefined) processes.push({ pid, argv });
      }
      return processes;
    },
    catch: (cause) => cause,
  }),
  kill: (pid) =>
    Effect.try({
      try: () => {
        process.kill(pid, "SIGKILL");
      },
      catch: (cause) => cause,
    }),
};

export const reapLingeringExecConmons = Effect.fnUntraced(function* (options: {
  readonly conmonPath: string;
  readonly names?: ReadonlySet<string>;
  readonly containerIds?: ReadonlySet<string>;
  readonly reaper?: ExecConmonReaper;
}): Effect.fn.Return<number> {
  const reaper = options.reaper ?? hostExecConmonReaper;
  const processes = yield* reaper.listArgv.pipe(
    Effect.catch(() => Effect.succeed<ReadonlyArray<ExecConmonProcess>>([])),
  );
  const liveContainerIds = new Set<string>();
  for (const candidate of processes) {
    if (candidate.argv[0] !== options.conmonPath || isExecAttachArgv(candidate.argv)) continue;
    const containerId = flagValue(candidate.argv, "-c");
    if (containerId !== undefined) liveContainerIds.add(containerId);
  }
  let killed = 0;
  for (const candidate of processes) {
    if (!isLingeringExecConmon(candidate.argv, options.conmonPath, options, liveContainerIds)) continue;
    const didKill = yield* reaper.kill(candidate.pid).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false)),
    );
    if (didKill) killed += 1;
  }
  return killed;
});
