import { createHash } from "node:crypto";
import { basename } from "node:path";

import { MANAGED_SCOPE_ENV_BIN, PODMAN_REDIRECT_DENYLIST } from "./managed-invocation.ts";

/**
 * Native health on the managed Linux runtime: transient systemd user timers whose oneshot services
 * run `podman --remote healthcheck run` against the managed socket. The service itself runs with
 * DISABLE_HC_SYSTEMD and off the user's bus, so these timers are the only scheduler. Pure argv and
 * environment builders; the provider runs them.
 */

/** A native health timer's job: `main` keeps the healthcheck interval, `start` the start interval. */
export type ManagedHealthRole = "main" | "start";

/** Unit name prefix shared by one managed runtime's health timers: `lando-<16 hex>-hc-`. */
export const managedHealthUnitPrefix = (privateRuntimeDir: string): string =>
  `${basename(privateRuntimeDir)}-hc-`;

/**
 * One container run: its id plus a digest of its full StartedAt, so every restart, resume or
 * recreation gets new units and the old ones become stale.
 */
export const managedHealthRunKey = (containerId: string, startedAt: string): string =>
  `${containerId}-${createHash("sha256").update(startedAt).digest("hex").slice(0, 12)}`;

export const managedHealthUnitName = (prefix: string, key: string, role: ManagedHealthRole): string =>
  `${prefix}${key}-${role}`;

export interface ManagedHealthUnit {
  readonly key: string;
  readonly role: ManagedHealthRole;
  readonly kind: "timer" | "service";
  readonly active: boolean;
}

/** Health units in `systemctl list-units --plain --no-legend` output: `UNIT LOAD ACTIVE SUB ...`. */
export const parseManagedHealthUnits = (prefix: string, output: string): ReadonlyArray<ManagedHealthUnit> => {
  const pattern = new RegExp(`^${prefix}([0-9a-f]{64}-[0-9a-f]{12})-(main|start)\\.(timer|service)$`, "u");
  return output.split("\n").flatMap((line) => {
    const fields = line.trim().split(/\s+/u);
    const index = fields.findIndex((field) => pattern.test(field));
    const match = pattern.exec(fields[index] ?? "");
    if (match === null) return [];
    const [, key = "", role, kind] = match;
    return [
      {
        key,
        role: role === "start" ? "start" : "main",
        kind: kind === "timer" ? "timer" : "service",
        active: fields[index + 2] === "active",
      },
    ];
  });
};

/** `unix://` URL for the remote client; Go's url.Parse rejects a raw `%`, so segments are encoded. */
const managedRemoteSocketUrl = (socketPath: string): string =>
  `unix://${socketPath.split("/").map(encodeURIComponent).join("/")}`;

/** The only environment Lando gives `systemd-run`/`systemctl`: they reach `<dir>/systemd/private`. */
export const managedUserManagerEnv = (userRuntimeDir: string): Readonly<Record<string, string>> => ({
  XDG_RUNTIME_DIR: userRuntimeDir,
});

export interface ManagedHealthTimer {
  /** Absolute host `systemd-run`, never the runtime-bin shim. */
  readonly systemdRun: string;
  readonly unit: string;
  readonly firstMs: number;
  readonly cadenceMs: number;
  readonly timeoutSeconds: number;
  /** The managed service's scope; the timer stops with it. */
  readonly scope?: string;
  /** The start-phase unit this main unit takes over from, after any run in progress finishes. */
  readonly takesOverFrom?: string;
  readonly runtimeBinDir: string;
  readonly socketPath: string;
  readonly runtimeConfigDir: string;
  readonly containerId: string;
}

const healthUnsetEnvironment = [
  ...[...PODMAN_REDIRECT_DENYLIST].filter((name) => name !== "CONTAINER_HOST"),
  "DBUS_SESSION_BUS_ADDRESS",
].join(" ");

/**
 * A transient user timer whose oneshot service runs the remote client against the managed socket.
 * Data-root paths reach the service only through environment properties, never ExecStart, so no
 * `$` or `%` in them is ever expanded.
 */
export const managedHealthTimerArgv = (timer: ManagedHealthTimer): ReadonlyArray<string> => [
  timer.systemdRun,
  "--user",
  "--quiet",
  "--collect",
  `--unit=${timer.unit}`,
  "--description=Lando native healthcheck",
  `--on-active=${timer.firstMs}ms`,
  `--on-unit-inactive=${timer.cadenceMs}ms`,
  `--timer-property=AccuracySec=${Math.min(1000, Math.max(10, Math.floor(timer.cadenceMs / 10)))}ms`,
  ...(timer.scope === undefined
    ? []
    : [`--timer-property=BindsTo=${timer.scope}`, `--timer-property=After=${timer.scope}`]),
  "-p",
  "Type=oneshot",
  "-p",
  `TimeoutStartSec=${timer.timeoutSeconds + 30}s`,
  "-p",
  "LogLevelMax=notice",
  "-p",
  "StartLimitIntervalSec=0",
  ...(timer.takesOverFrom === undefined
    ? []
    : ["-p", `Conflicts=${timer.takesOverFrom}.timer`, "-p", `After=${timer.takesOverFrom}.service`]),
  "-p",
  `UnsetEnvironment=${healthUnsetEnvironment}`,
  `--setenv=PATH=${timer.runtimeBinDir}`,
  `--setenv=CONTAINER_HOST=${managedRemoteSocketUrl(timer.socketPath)}`,
  `--setenv=CONTAINERS_CONF=${timer.runtimeConfigDir}/containers.conf`,
  "--",
  MANAGED_SCOPE_ENV_BIN,
  "podman",
  "--remote",
  "healthcheck",
  "run",
  "--ignore-result",
  timer.containerId,
];

export const managedHealthListArgv = (systemctl: string, prefix: string): ReadonlyArray<string> => [
  systemctl,
  "--user",
  "list-units",
  "--all",
  "--plain",
  "--full",
  "--no-legend",
  "--no-pager",
  "--type=timer,service",
  `${prefix}*`,
];

/** Stops matching units; glob patterns match only loaded units, so vanished ones are a no-op. */
export const managedHealthStopArgv = (
  systemctl: string,
  patterns: ReadonlyArray<string>,
): ReadonlyArray<string> => [systemctl, "--user", "stop", ...patterns];
