import {
  type OccupancyHolderIdentity,
  type OccupancyHolderKind,
  classifyOccupancyHolder,
} from "./preferred-host-ports-holders.ts";

const SKIP_SYSTEMD_UNITS = new Set([
  "containerd",
  "crio",
  "dbus",
  "docker",
  "podman",
  "ssh",
  "sshd",
  "systemd-logind",
  "systemd-networkd",
  "systemd-resolved",
]);

const HOLDER_LABEL = {
  apache: "Apache",
  caddy: "Caddy",
  ddev: "DDEV",
  docksal: "Docksal",
  iis: "IIS",
  lando3: "Lando v3",
  nginx: "nginx",
} as const satisfies Record<Exclude<OccupancyHolderKind, "unknown">, string>;

export type OccupiedPortHolderFields = {
  readonly holder: string;
  readonly holderPid: number;
  readonly holderCmdline?: string;
  readonly holderSystemdUnit?: string;
};

export type OccupiedPortWarningInput = {
  readonly preferred: number;
  readonly chosen: number;
  readonly kind: OccupancyHolderKind;
  readonly identity?: OccupancyHolderIdentity;
  readonly systemdUnit?: string;
};

export const systemdServiceFromCgroup = (cgroup: string): string | undefined => {
  const match = /\/([A-Za-z0-9:_.\\@-]+)\.service(?:[/\n]|$)/u.exec(cgroup);
  const name = match?.[1];
  if (name === undefined) return undefined;
  const template = name.split("@")[0] ?? name;
  if (SKIP_SYSTEMD_UNITS.has(name) || SKIP_SYSTEMD_UNITS.has(template)) return undefined;
  return name;
};

export const fieldsFromPortHolder = (
  holder: { readonly comm: string; readonly pid: number; readonly cmdline?: string },
  systemdUnit?: string,
): OccupiedPortHolderFields => ({
  holder: holder.comm,
  holderPid: holder.pid,
  ...(holder.cmdline === undefined ? {} : { holderCmdline: holder.cmdline }),
  ...(systemdUnit === undefined ? {} : { holderSystemdUnit: systemdUnit }),
});

const processLabel = (identity: OccupancyHolderIdentity | undefined): string | undefined => {
  const comm = identity?.comm;
  const pid = identity?.pid;
  const hasComm = comm !== undefined && comm.length > 0;
  if (hasComm && pid !== undefined) return `process "${comm}" (pid ${String(pid)})`;
  if (hasComm) return `process "${comm}"`;
  if (pid !== undefined) return `pid ${String(pid)}`;
  return undefined;
};

const occupantPhrase = (input: OccupiedPortWarningInput): string => {
  if (input.kind !== "unknown") return ` by ${HOLDER_LABEL[input.kind]}`;
  const process = processLabel(input.identity);
  if (process !== undefined) return ` by ${process}`;
  if (input.systemdUnit !== undefined) return ` by ${input.systemdUnit}.service`;
  return "";
};

const ALTERNATE_URL_HELP = "The alternate URL is available; run lando info to see it.";

const formatOccupiedPortHop = (input: OccupiedPortWarningInput): string =>
  `Port ${String(input.preferred)} is in use${occupantPhrase(input)}; using ${String(input.chosen)}.`;

export const formatOccupiedPortWarning = (input: OccupiedPortWarningInput): string =>
  `${formatOccupiedPortHop(input)} ${ALTERNATE_URL_HELP}`;

export type OccupiedPortProbe = {
  readonly holder?: string;
  readonly holderPid?: number;
  readonly holderCmdline?: string;
  readonly holderSystemdUnit?: string;
};

const portWarningInput = (
  preferred: number,
  chosen: number,
  probe: OccupiedPortProbe,
): OccupiedPortWarningInput => ({
  preferred,
  chosen,
  kind: classifyOccupancyHolder({
    ...(probe.holder === undefined ? {} : { comm: probe.holder }),
    ...(probe.holderCmdline === undefined ? {} : { cmdline: probe.holderCmdline }),
  }),
  identity: {
    ...(probe.holder === undefined ? {} : { comm: probe.holder }),
    ...(probe.holderPid === undefined ? {} : { pid: probe.holderPid }),
  },
  ...(probe.holderSystemdUnit === undefined ? {} : { systemdUnit: probe.holderSystemdUnit }),
});

export const warningFromHolder = (preferred: number, chosen: number, probe: OccupiedPortProbe): string =>
  formatOccupiedPortWarning(portWarningInput(preferred, chosen, probe));

export const occupiedHopNotices = (input: {
  readonly preferredHttp: number;
  readonly preferredHttps: number;
  readonly httpPort: number;
  readonly httpsPort: number;
  readonly http: OccupiedPortProbe;
  readonly https: OccupiedPortProbe;
}): readonly string[] => {
  const notices: string[] = [];
  if (input.httpPort !== input.preferredHttp) {
    notices.push(formatOccupiedPortHop(portWarningInput(input.preferredHttp, input.httpPort, input.http)));
  }
  if (input.httpsPort !== input.preferredHttps) {
    notices.push(formatOccupiedPortHop(portWarningInput(input.preferredHttps, input.httpsPort, input.https)));
  }
  if (notices.length > 0) {
    const last = notices.length - 1;
    notices[last] = `${notices[last]}\n${ALTERNATE_URL_HELP}`;
  }
  return notices;
};
