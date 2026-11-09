import { ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProviderStatus } from "@lando/sdk/services";

export const MANAGED_RUNTIME_BUNDLE_MARKER = ".runtime-installed-version";

export const parseManagedMachineState = (
  stdout: string,
): "running" | "stopped" | "missing" | ProviderUnavailableError => {
  const failure = () =>
    new ProviderUnavailableError({
      providerId: "lando",
      operation: "inspect",
      message: "Podman machine inspection did not establish a running or stopped Lando machine.",
      remediation:
        "Inspect `podman machine inspect lando` and restore access to the managed machine before retrying.",
    });
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (error) {
    if (error instanceof SyntaxError) return failure();
    throw error;
  }
  const machine: unknown = Array.isArray(decoded) ? decoded[0] : decoded;
  if (machine === undefined || machine === null) return "missing";
  if (typeof machine !== "object") return failure();
  const state = "State" in machine ? machine.State : "state" in machine ? machine.state : undefined;
  if (typeof state !== "string") return failure();
  switch (state.toLowerCase()) {
    case "running":
      return "running";
    case "stopped":
      return "stopped";
    default:
      return failure();
  }
};

export interface ManagedProcess {
  readonly pid: number;
  readonly parentPid: number;
  readonly argv: ReadonlyArray<string>;
}

export interface ManagedProcessIdentity {
  readonly socketPath: string;
  /** This data root's runtime bin directory, as configured and canonicalized. */
  readonly runtimeBinDirs: ReadonlyArray<string>;
  readonly recordedPid: number | undefined;
}

export const descendsFrom = (
  processes: ReadonlyArray<Pick<ManagedProcess, "pid" | "parentPid">>,
  pid: number,
  ancestor: number,
): boolean | undefined => {
  const parents = new Map(processes.map((entry) => [entry.pid, entry.parentPid]));
  const visited = new Set<number>();
  let current = pid;
  while (current > 1 && !visited.has(current)) {
    if (current === ancestor) return true;
    visited.add(current);
    const parent = parents.get(current);
    if (parent === undefined) return undefined;
    current = parent;
  }
  return current <= 1 ? false : undefined;
};

export const isManagedService = (argv: ReadonlyArray<string>, socketPath: string): boolean =>
  argv.some((arg, index) => arg === "system" && argv[index + 1] === "service") &&
  argv.includes(`unix://${socketPath}`);

/**
 * Matches provide positive diagnostic evidence only. Rewritten or empty argv,
 * host pause executables, hidden processes, and concurrent admissions make an
 * empty result insufficient to prove workload absence.
 */
export const managedProcessPids = (
  processes: ReadonlyArray<ManagedProcess>,
  identity: ManagedProcessIdentity,
): ReadonlyArray<number> => {
  const service = processes.find(
    (entry) => entry.pid === identity.recordedPid && isManagedService(entry.argv, identity.socketPath),
  );
  return processes
    .filter(
      (entry) =>
        isManagedService(entry.argv, identity.socketPath) ||
        identity.runtimeBinDirs.some((dir) => entry.argv[0]?.startsWith(`${dir}/`) === true) ||
        (service !== undefined && descendsFrom(processes, entry.pid, service.pid) === true),
    )
    .map((entry) => entry.pid);
};

export type ManagedRuntimeEvidence =
  | { readonly state: "answering" }
  | { readonly state: "silent"; readonly bundleInstalled: boolean; readonly livePids: ReadonlyArray<number> }
  | { readonly state: "unreadable" };

export const classifyManagedRuntime = (
  evidence: ManagedRuntimeEvidence,
): ProviderStatus | ProviderUnavailableError => {
  switch (evidence.state) {
    case "answering":
      return { state: "running", message: "runtime socket reachable" };
    case "unreadable":
      return new ProviderUnavailableError({
        providerId: "lando",
        operation: "getStatus",
        message: "Managed runtime process evidence could not be read; runtime state is unknown.",
        remediation: "Restore read access to your processes in /proc, then rerun `lando doctor`.",
      });
    case "silent":
      if (evidence.livePids.length > 0)
        return new ProviderUnavailableError({
          providerId: "lando",
          operation: "getStatus",
          message: "Managed runtime processes are alive but the runtime API is not answering.",
          remediation: "Inspect the runtime service with `lando doctor` and its service log before retrying.",
          details: { pids: evidence.livePids },
        });
      if (!evidence.bundleInstalled)
        return new ProviderUnavailableError({
          providerId: "lando",
          operation: "getStatus",
          message: "The managed runtime bundle is not installed.",
          remediation: "Run `lando setup` to install the managed runtime.",
        });
      return new ProviderUnavailableError({
        providerId: "lando",
        operation: "getStatus",
        message:
          "The managed runtime API is absent; process observations cannot prove that no workloads are running. Runtime state is unknown.",
        remediation:
          "Inspect the runtime service with `lando doctor` and its service log. `lando start` can restore runtime access; observation and stop do not launch it.",
      });
  }
};
