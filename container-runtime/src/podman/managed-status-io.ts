import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProcessRunner, ProviderStatus } from "@lando/sdk/services";
import { Effect } from "effect";
import type { Context } from "effect";
import { withoutPodmanRedirectsDefined } from "./managed-invocation.ts";
import {
  MANAGED_RUNTIME_BUNDLE_MARKER,
  type ManagedProcess,
  classifyManagedRuntime,
  managedProcessPids,
  parseManagedMachineState,
} from "./managed-status.ts";

const isAbsent = (error: unknown): boolean =>
  error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "ESRCH");

const readOptional = async (path: string): Promise<string | undefined> => {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (isAbsent(error)) return undefined;
    throw error;
  }
};

export const readManagedProcesses = async (procRoot = "/proc"): Promise<ReadonlyArray<ManagedProcess>> => {
  const processes: ManagedProcess[] = [];
  const uid = process.getuid?.();
  const entries = await readdir(procRoot);
  for (const entry of entries) {
    if (!/^\d+$/u.test(entry)) continue;
    const root = join(procRoot, entry);
    try {
      const status = await readFile(join(root, "status"), "utf8");
      const owner = status.match(/^Uid:\s+(\d+)/mu)?.[1];
      const parent = status.match(/^PPid:\s+(\d+)/mu)?.[1];
      if (owner === undefined || parent === undefined || uid === undefined)
        throw new TypeError("Unreadable process identity");
      if (Number(owner) !== uid || /^State:\s+Z/mu.test(status)) continue;
      // `status` and `cmdline` stay readable for the user's non-dumpable
      // processes (systemd --user, ssh-agent), unlike `environ` and `ns/*`.
      const argv = (await readFile(join(root, "cmdline"), "utf8")).split("\0").filter(Boolean);
      processes.push({ pid: Number(entry), parentPid: Number(parent), argv });
    } catch (error) {
      if (!isAbsent(error)) throw error;
    }
  }
  return processes;
};

export interface ManagedStatusPaths {
  readonly runtimeBinDir: string;
  readonly providerSocketPath: string;
  readonly providerPidPath: string;
}

export const inspectManagedMachine = Effect.fn("ManagedRuntime.inspectMachine")(function* (input: {
  readonly runtimeBinDir: string;
  readonly platform: "darwin" | "win32";
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly runner: Pick<Context.Service.Shape<typeof ProcessRunner>, "run">;
}) {
  const response = yield* input.runner.run({
    cmd: join(input.runtimeBinDir, input.platform === "win32" ? "podman.exe" : "podman"),
    args: ["machine", "inspect", "lando"],
    env: withoutPodmanRedirectsDefined(input.env),
    replaceEnv: true,
    timeoutMs: 1500,
  });
  if (response.exitCode !== 0)
    return yield* Effect.fail(
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "inspect",
        message: "The Lando machine could not be inspected.",
        remediation:
          "Restore access to the installed managed Podman tooling and inspect the Lando machine before retrying.",
      }),
    );
  const state = parseManagedMachineState(response.stdout);
  if (state instanceof ProviderUnavailableError) return yield* Effect.fail(state);
  return state;
});

export const inspectSilentManagedRuntime = (
  paths: ManagedStatusPaths,
): Effect.Effect<ProviderStatus, ProviderUnavailableError> =>
  Effect.tryPromise({
    try: async () => {
      const processes = await readManagedProcesses();
      const rawPid = await readOptional(paths.providerPidPath);
      const runtimeBinDirs = new Set([paths.runtimeBinDir]);
      try {
        runtimeBinDirs.add(await realpath(paths.runtimeBinDir));
      } catch (error) {
        if (!isAbsent(error)) throw error;
      }
      const livePids = managedProcessPids(processes, {
        socketPath: paths.providerSocketPath,
        runtimeBinDirs: [...runtimeBinDirs],
        recordedPid: rawPid !== undefined && /^\d+\s*$/u.test(rawPid) ? Number(rawPid.trim()) : undefined,
      });
      let bundleInstalled = false;
      try {
        const marker = await readOptional(join(paths.runtimeBinDir, MANAGED_RUNTIME_BUNDLE_MARKER));
        const binary = await stat(join(paths.runtimeBinDir, "podman"));
        bundleInstalled =
          marker !== undefined && marker.trim().length > 0 && binary.isFile() && (binary.mode & 0o111) !== 0;
      } catch (error) {
        if (!isAbsent(error)) throw error;
      }
      return classifyManagedRuntime({ state: "silent", bundleInstalled, livePids });
    },
    catch: (cause) =>
      new ProviderUnavailableError({
        providerId: "lando",
        operation: "getStatus",
        cause,
        message: "Managed runtime process evidence could not be read; runtime state is unknown.",
        remediation:
          "Restore read access to your processes in /proc and the managed runtime files, then rerun `lando doctor`.",
      }),
  }).pipe(
    Effect.flatMap((status) =>
      status instanceof ProviderUnavailableError ? Effect.fail(status) : Effect.succeed(status),
    ),
  );

export const readProcessDescendant = (pid: number, ancestor: number): Effect.Effect<boolean | undefined> =>
  Effect.tryPromise({
    try: async () => {
      const visited = new Set<number>();
      let current = pid;
      while (current > 1 && !visited.has(current)) {
        if (current === ancestor) return true;
        visited.add(current);
        const status = await readFile(`/proc/${current}/status`, "utf8");
        const parent = status.match(/^PPid:\s+(\d+)/mu)?.[1];
        if (parent === undefined) return undefined;
        current = Number(parent);
      }
      return current <= 1 ? false : undefined;
    },
    catch: () => undefined,
  }).pipe(Effect.catch(() => Effect.succeed(undefined)));
