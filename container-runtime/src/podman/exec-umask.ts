import type { EngineHttpApi } from "../engine-api.ts";

export const EXEC_UMASK_WRAPPER_SHELL = "/bin/sh";
export const EXEC_UMASK_WRAPPER_SCRIPT = 'umask 0022; exec "$@"';
export const EXEC_UMASK_WRAPPER_ARGV0 = "lando-exec";
export const EXEC_UMASK_COMPENSATION = "0022";
export const WORLD_WRITABLE_UMASK = "0000";

export const EXEC_UMASK_PROBE_COMMAND = ["cat", "/proc/self/status"] as const;
export const EXEC_UMASK_SHELL_PROBE_COMMAND = [EXEC_UMASK_WRAPPER_SHELL, "-c", "exit 0"] as const;

const UMASK_LINE = /^Umask:\s*([0-7]{3,4})\b/mu;
const MISSING_SHELL_EXITS = new Set([126, 127]);

export type ExecUmaskProbeResult =
  | { readonly status: "ok"; readonly umask: string }
  | { readonly status: "unavailable" };

export type ShellProbeOutcome = "present" | "missing" | "unknown";

type ProbeCache<Value> = WeakMap<EngineHttpApi, Map<string, Map<string | undefined, Value>>>;
const umaskResults: ProbeCache<ExecUmaskProbeResult> = new WeakMap();
const shellResolved: ProbeCache<boolean> = new WeakMap();
const missingShellWarned = new WeakMap<EngineHttpApi, Set<string>>();

const sameArgv = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

const containerSet = (store: WeakMap<EngineHttpApi, Set<string>>, api: EngineHttpApi): Set<string> => {
  const existing = store.get(api);
  if (existing !== undefined) return existing;
  const created = new Set<string>();
  store.set(api, created);
  return created;
};

const probeMap = <Value>(
  store: ProbeCache<Value>,
  api: EngineHttpApi,
  containerId: string,
): Map<string | undefined, Value> => {
  let containers = store.get(api);
  if (containers === undefined) {
    containers = new Map();
    store.set(api, containers);
  }
  const existing = containers.get(containerId);
  if (existing !== undefined) return existing;
  const created = new Map<string | undefined, Value>();
  containers.set(containerId, created);
  return created;
};

export const parseProcSelfStatusUmask = (text: string): string | undefined => {
  const match = UMASK_LINE.exec(text);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  return raw.padStart(4, "0");
};

export const isWorldWritableUmask = (umask: string): boolean => umask === WORLD_WRITABLE_UMASK;

export const isMissingShellExit = (exitCode: number): boolean => MISSING_SHELL_EXITS.has(exitCode);

export const shellProbeOutcome = (exitCode: number): ShellProbeOutcome => {
  if (exitCode === 0) return "present";
  if (isMissingShellExit(exitCode)) return "missing";
  return "unknown";
};

export const wrapExecCommand = (command: ReadonlyArray<string>): ReadonlyArray<string> => [
  EXEC_UMASK_WRAPPER_SHELL,
  "-c",
  EXEC_UMASK_WRAPPER_SCRIPT,
  EXEC_UMASK_WRAPPER_ARGV0,
  ...command,
];

export const isWrappedExecCommand = (command: ReadonlyArray<string>): boolean =>
  command.length >= 4 &&
  command[0] === EXEC_UMASK_WRAPPER_SHELL &&
  command[1] === "-c" &&
  command[2] === EXEC_UMASK_WRAPPER_SCRIPT &&
  command[3] === EXEC_UMASK_WRAPPER_ARGV0;

export const isUmaskProbeCommand = (command: ReadonlyArray<string>): boolean =>
  sameArgv(command, EXEC_UMASK_PROBE_COMMAND);

export const isShellProbeCommand = (command: ReadonlyArray<string>): boolean =>
  sameArgv(command, EXEC_UMASK_SHELL_PROBE_COMMAND);

export const peekExecUmask = (
  api: EngineHttpApi,
  containerId: string,
  user?: string,
): ExecUmaskProbeResult | undefined => umaskResults.get(api)?.get(containerId)?.get(user);

export const rememberExecUmask = (
  api: EngineHttpApi,
  containerId: string,
  result: ExecUmaskProbeResult,
  user?: string,
): void => {
  probeMap(umaskResults, api, containerId).set(user, result);
};

export const peekContainerHasShell = (
  api: EngineHttpApi,
  containerId: string,
  user?: string,
): boolean | undefined => shellResolved.get(api)?.get(containerId)?.get(user);

export const rememberContainerHasShell = (
  api: EngineHttpApi,
  containerId: string,
  hasShell: boolean,
  user?: string,
): void => {
  probeMap(shellResolved, api, containerId).set(user, hasShell);
};

export const claimMissingShellWarning = (api: EngineHttpApi, containerId: string): boolean => {
  const warned = containerSet(missingShellWarned, api);
  if (warned.has(containerId)) return false;
  warned.add(containerId);
  return true;
};

export const missingShellWarning = (service: string): string =>
  `Service ${service} cannot run /bin/sh for the selected exec user; umask compensation is skipped. Files created by exec may be world-writable.`;
