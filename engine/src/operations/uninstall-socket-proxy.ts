import type { UninstallPlanStep, UninstallStepOutcome } from "./uninstall.ts";

// Lockstep with plugins/proxy-traefik/src/socket-proxy-units.ts UNIT_MARKER.
// Engine must not import @lando/proxy-traefik.
export const SOCKET_PROXY_UNIT_MARKER = "# lando-proxy-socket-helper" as const;

export const DEFAULT_SOCKET_PROXY_UNIT_PATHS = [
  "/etc/systemd/system/lando-proxy-http.socket",
  "/etc/systemd/system/lando-proxy-http.service",
  "/etc/systemd/system/lando-proxy-https.socket",
  "/etc/systemd/system/lando-proxy-https.service",
] as const;

export const DEFAULT_SOCKET_PROXY_POLKIT_PATH = "/etc/polkit-1/rules.d/10-lando-proxy.rules" as const;

const SOCKET_UNIT_NAMES = ["lando-proxy-http.socket", "lando-proxy-https.socket"] as const;

export interface SocketProxyHelperPaths {
  readonly unitPaths: ReadonlyArray<string>;
  readonly polkitPath: string;
}

export interface SocketProxyHelperIo {
  readonly exists: (path: string) => boolean;
  readonly readText: (path: string) => string;
}

const tryReadText = (path: string, readText: (path: string) => string): string | undefined => {
  try {
    return readText(path);
  } catch {
    return undefined;
  }
};

const isOwnedHelperFile = (content: string): boolean => content.includes(SOCKET_PROXY_UNIT_MARKER);

const classifyHelperPaths = (
  paths: SocketProxyHelperPaths,
  io: SocketProxyHelperIo,
): {
  readonly owned: ReadonlyArray<string>;
  readonly foreign: ReadonlyArray<string>;
  readonly missing: ReadonlyArray<string>;
} => {
  const candidates = [...paths.unitPaths, paths.polkitPath];
  const owned: string[] = [];
  const foreign: string[] = [];
  const missing: string[] = [];
  for (const path of candidates) {
    if (!io.exists(path)) {
      missing.push(path);
      continue;
    }
    const content = tryReadText(path, io.readText);
    if (content !== undefined && isOwnedHelperFile(content)) owned.push(path);
    else foreign.push(path);
  }
  return { owned, foreign, missing };
};

export const socketProxyHelperStep = (
  paths: SocketProxyHelperPaths,
  io: SocketProxyHelperIo,
): UninstallPlanStep => {
  const classified = classifyHelperPaths(paths, io);
  const target =
    classified.owned.length > 0
      ? classified.owned.join(", ")
      : [...paths.unitPaths, paths.polkitPath].join(", ");
  const base = {
    id: "socket-proxy-helper",
    label: "socket proxy helper",
    target,
    destructive: true,
  };
  if (classified.owned.length > 0) {
    return {
      ...base,
      status: "owned",
      detail: "Stop Lando-owned proxy sockets and remove marked systemd units and polkit rule.",
    };
  }
  if (classified.foreign.length > 0) {
    return {
      ...base,
      status: "user-owned",
      detail: "Socket-proxy helper files exist but lack the Lando ownership marker; leave them in place.",
    };
  }
  return {
    ...base,
    status: "skipped",
    detail: "No Lando-owned proxy socket helper units are present.",
  };
};

export interface ExecuteSocketProxyHelperInput {
  readonly paths: SocketProxyHelperPaths;
  readonly io: SocketProxyHelperIo;
  readonly remove: (path: string) => Promise<void>;
  readonly elevate?: (
    command: ReadonlyArray<string>,
  ) => Promise<{ readonly exitCode: number; readonly stdout?: string; readonly stderr?: string }>;
}

const shQuote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export const executeSocketProxyHelperStep = async (
  input: ExecuteSocketProxyHelperInput,
): Promise<UninstallStepOutcome> => {
  const owned = classifyHelperPaths(input.paths, input.io).owned;
  if (input.elevate !== undefined) {
    const script = [
      `systemctl stop ${SOCKET_UNIT_NAMES.join(" ")}`,
      ...owned.map((path) => `rm -f -- ${shQuote(path)}`),
      "systemctl daemon-reload",
    ].join("\n");
    await input.elevate(["/bin/sh", "-c", script]);
  }
  for (const path of owned) {
    await input.remove(path);
  }
  return "completed";
};
