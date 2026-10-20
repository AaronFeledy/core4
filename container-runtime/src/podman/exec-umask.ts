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

const umaskOk = new WeakMap<EngineHttpApi, Extract<ExecUmaskProbeResult, { readonly status: "ok" }>>();
const umaskUnavailableByContainer = new WeakMap<EngineHttpApi, Set<string>>();
const shellResolved = new WeakMap<EngineHttpApi, Map<string, boolean>>();
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

const containerMap = <Value>(
  store: WeakMap<EngineHttpApi, Map<string, Value>>,
  api: EngineHttpApi,
): Map<string, Value> => {
  const existing = store.get(api);
  if (existing !== undefined) return existing;
  const created = new Map<string, Value>();
  store.set(api, created);
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

export const peekExecUmask = (api: EngineHttpApi): ExecUmaskProbeResult | undefined => umaskOk.get(api);

export const rememberExecUmask = (api: EngineHttpApi, result: ExecUmaskProbeResult): void => {
  if (result.status !== "ok") return;
  umaskOk.set(api, result);
};

export const seedNonCompensatingExecUmask = (api: EngineHttpApi): void => {
  rememberExecUmask(api, { status: "ok", umask: EXEC_UMASK_COMPENSATION });
};

export const peekUnavailableExecUmask = (api: EngineHttpApi, containerId: string): boolean =>
  umaskUnavailableByContainer.get(api)?.has(containerId) === true;

export const rememberUnavailableExecUmask = (api: EngineHttpApi, containerId: string): void => {
  containerSet(umaskUnavailableByContainer, api).add(containerId);
};

export const peekContainerHasShell = (api: EngineHttpApi, containerId: string): boolean | undefined =>
  shellResolved.get(api)?.get(containerId);

export const rememberContainerHasShell = (
  api: EngineHttpApi,
  containerId: string,
  hasShell: boolean,
): void => {
  containerMap(shellResolved, api).set(containerId, hasShell);
};

export const claimMissingShellWarning = (api: EngineHttpApi, containerId: string): boolean => {
  const warned = containerSet(missingShellWarned, api);
  if (warned.has(containerId)) return false;
  warned.add(containerId);
  return true;
};

export const missingShellWarning = (service: string): string =>
  `Service ${service} has no /bin/sh; exec umask compensation is skipped. Files created by exec may be world-writable.`;
