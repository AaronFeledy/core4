import type { EngineHttpApi } from "../engine-api.ts";

export const EXEC_UMASK_WRAPPER_SHELL = "/bin/sh";
export const EXEC_UMASK_WRAPPER_SCRIPT = 'umask 0022; exec "$@"';
export const EXEC_UMASK_WRAPPER_ARGV0 = "lando-exec";
export const EXEC_UMASK_COMPENSATION = "0022";
export const WORLD_WRITABLE_UMASK = "0000";

export const EXEC_UMASK_PROBE_COMMAND = ["cat", "/proc/self/status"] as const;
export const EXEC_UMASK_SHELL_PROBE_COMMAND = [EXEC_UMASK_WRAPPER_SHELL, "-c", "exit 0"] as const;

const UMASK_LINE = /^Umask:\s*([0-7]{3,4})\b/mu;

export type ExecUmaskProbeResult =
  | { readonly status: "ok"; readonly umask: string }
  | { readonly status: "unavailable" };

const umaskResolved = new WeakMap<EngineHttpApi, ExecUmaskProbeResult>();
const umaskFlights = new WeakMap<EngineHttpApi, Promise<ExecUmaskProbeResult>>();
const shellResolved = new WeakMap<EngineHttpApi, Map<string, boolean>>();
const shellFlights = new WeakMap<EngineHttpApi, Map<string, Promise<boolean>>>();
const missingShellWarned = new WeakMap<EngineHttpApi, Set<string>>();

const sameArgv = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((value, index) => value === right[index]);

export const parseProcSelfStatusUmask = (text: string): string | undefined => {
  const match = UMASK_LINE.exec(text);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  return raw.padStart(4, "0");
};

export const isWorldWritableUmask = (umask: string): boolean => umask === WORLD_WRITABLE_UMASK;

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

export const isInternalExecProbeCommand = (command: ReadonlyArray<string>): boolean =>
  isUmaskProbeCommand(command) || isShellProbeCommand(command);

export const peekExecUmask = (api: EngineHttpApi): ExecUmaskProbeResult | undefined => umaskResolved.get(api);

export const rememberExecUmask = (api: EngineHttpApi, result: ExecUmaskProbeResult): void => {
  umaskResolved.set(api, result);
  umaskFlights.set(api, Promise.resolve(result));
};

export const seedNonCompensatingExecUmask = (api: EngineHttpApi): void => {
  rememberExecUmask(api, { status: "ok", umask: EXEC_UMASK_COMPENSATION });
};

export const loadExecUmask = (
  api: EngineHttpApi,
  probe: () => Promise<ExecUmaskProbeResult>,
): Promise<ExecUmaskProbeResult> => {
  const resolved = umaskResolved.get(api);
  if (resolved !== undefined) return Promise.resolve(resolved);
  const existing = umaskFlights.get(api);
  if (existing !== undefined) return existing;
  const flight = probe().then((result) => {
    umaskResolved.set(api, result);
    return result;
  });
  umaskFlights.set(api, flight);
  return flight;
};

const serviceShellMap = <Value>(
  store: WeakMap<EngineHttpApi, Map<string, Value>>,
  api: EngineHttpApi,
): Map<string, Value> => {
  const existing = store.get(api);
  if (existing !== undefined) return existing;
  const created = new Map<string, Value>();
  store.set(api, created);
  return created;
};

export const peekServiceHasShell = (api: EngineHttpApi, service: string): boolean | undefined =>
  shellResolved.get(api)?.get(service);

export const rememberServiceHasShell = (api: EngineHttpApi, service: string, hasShell: boolean): void => {
  serviceShellMap(shellResolved, api).set(service, hasShell);
  serviceShellMap(shellFlights, api).set(service, Promise.resolve(hasShell));
};

export const loadServiceHasShell = (
  api: EngineHttpApi,
  service: string,
  probe: () => Promise<boolean>,
): Promise<boolean> => {
  const resolved = peekServiceHasShell(api, service);
  if (resolved !== undefined) return Promise.resolve(resolved);
  const flights = serviceShellMap(shellFlights, api);
  const existing = flights.get(service);
  if (existing !== undefined) return existing;
  const flight = probe().then((hasShell) => {
    serviceShellMap(shellResolved, api).set(service, hasShell);
    return hasShell;
  });
  flights.set(service, flight);
  return flight;
};

export const claimMissingShellWarning = (api: EngineHttpApi, service: string): boolean => {
  const warned = missingShellWarned.get(api) ?? new Set<string>();
  if (missingShellWarned.get(api) === undefined) missingShellWarned.set(api, warned);
  if (warned.has(service)) return false;
  warned.add(service);
  return true;
};

export const missingShellWarning = (service: string): string =>
  `Service ${service} has no /bin/sh; exec umask compensation is skipped. Files created by exec may be world-writable.`;
