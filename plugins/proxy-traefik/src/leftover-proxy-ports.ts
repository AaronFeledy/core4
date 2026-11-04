import { readFile, realpath } from "node:fs/promises";

import { globalAppRootPath, makeLandoPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import type { HostPlatform, RouterPortPair } from "@lando/sdk/schema";
import { Effect, absurd } from "effect";

import { type TraefikPublishState, resolveTraefikPublishPorts } from "./global-services/traefik.ts";
import {
  classifyRootlessportOrigin,
  commLooksLikeRootlessport,
  identifyLoopbackHolder,
  runtimeBinDirOfExe,
} from "./leftover-proxy-ports-linux.ts";
import { probeHttp, probeTcp } from "./loopback-probe.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";
import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";

export type LoopbackPortKind =
  | "leftover-rootlessport"
  | "other-data-root-forwarder"
  | "healthy-proxy"
  | "foreign"
  | "unknown";
export type LoopbackPortRole = "http" | "https";

export interface LoopbackPortSnapshot {
  readonly port: number;
  readonly host: "127.0.0.1";
  readonly listening: boolean;
  readonly comm?: string;
  readonly pid?: number;
  readonly exe?: string;
  readonly ownerRuntimeBinDir?: string;
  readonly kind?: LoopbackPortKind;
}

export interface LoopbackPortReaders {
  readonly readPort: (
    port: number,
    platform: HostPlatform,
    role?: LoopbackPortRole,
    runtimeBinDir?: string,
  ) => Promise<LoopbackPortSnapshot>;
}

export type LeftoverProxyPortPair = RouterPortPair;

const LOOPBACK_HOST = "127.0.0.1" as const;
const TCP_PROBE_MS = 200;
const HTTP_PROBE_MS = 500;
const LAST_FALLBACK: LeftoverProxyPortPair = {
  httpPort: TRAEFIK_HTTP_PORT,
  httpsPort: TRAEFIK_HTTPS_PORT,
};

const isLeftoverRootlessportHolder = (snapshot: LoopbackPortSnapshot): boolean =>
  snapshot.listening && snapshot.kind === "leftover-rootlessport";

const isOtherDataRootForwarder = (snapshot: LoopbackPortSnapshot): boolean =>
  snapshot.listening && snapshot.kind === "other-data-root-forwarder";

const idleSnapshot = (port: number): LoopbackPortSnapshot => ({
  port,
  host: LOOPBACK_HOST,
  listening: false,
});

const rootlessportKind = (
  runtimeBinDir: string | undefined,
  exe: string | undefined,
): Extract<LoopbackPortKind, "leftover-rootlessport" | "other-data-root-forwarder"> => {
  const origin = classifyRootlessportOrigin(exe, runtimeBinDir);
  return origin === "other-data-root" ? "other-data-root-forwarder" : "leftover-rootlessport";
};

const readPort = async (
  port: number,
  platform: HostPlatform,
  role: LoopbackPortRole = "http",
  runtimeBinDir?: string,
): Promise<LoopbackPortSnapshot> => {
  if (platform !== "linux" && platform !== "wsl") return idleSnapshot(port);

  const tcp = await probeTcp({ host: LOOPBACK_HOST, port, timeoutMs: TCP_PROBE_MS });
  switch (tcp) {
    case "refused":
      return idleSnapshot(port);
    case "unknown":
      return { port, host: LOOPBACK_HOST, listening: true, kind: "unknown" };
    case "open":
      break;
    default:
      return absurd<never>(tcp);
  }

  const holder = await identifyLoopbackHolder(port);
  const otherRoot =
    holder !== undefined &&
    commLooksLikeRootlessport(holder.comm) &&
    classifyRootlessportOrigin(holder.exe, runtimeBinDir) === "other-data-root";
  if (!otherRoot && (await probeHttp({ host: LOOPBACK_HOST, port, role, timeoutMs: HTTP_PROBE_MS }))) {
    return { port, host: LOOPBACK_HOST, listening: true, kind: "healthy-proxy" };
  }

  if (holder !== undefined && commLooksLikeRootlessport(holder.comm)) {
    const kind = rootlessportKind(runtimeBinDir, holder.exe);
    const ownerRuntimeBinDir = holder.exe === undefined ? undefined : runtimeBinDirOfExe(holder.exe);
    return {
      port,
      host: LOOPBACK_HOST,
      listening: true,
      comm: holder.comm,
      pid: holder.pid,
      kind,
      ...(holder.exe === undefined ? {} : { exe: holder.exe }),
      ...(ownerRuntimeBinDir === undefined ? {} : { ownerRuntimeBinDir }),
    };
  }
  if (holder !== undefined) {
    return {
      port,
      host: LOOPBACK_HOST,
      listening: true,
      comm: holder.comm,
      pid: holder.pid,
      kind: "foreign",
      ...(holder.exe === undefined ? {} : { exe: holder.exe }),
    };
  }
  return { port, host: LOOPBACK_HOST, listening: true, kind: "unknown" };
};

const systemReaders: LoopbackPortReaders = { readPort };

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const publishStateFromUnknown = (value: unknown): TraefikPublishState | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const mode = "mode" in value && typeof value.mode === "string" ? value.mode : undefined;
  const httpPort = "httpPort" in value ? optionalNumber(value.httpPort) : undefined;
  const httpsPort = "httpsPort" in value ? optionalNumber(value.httpsPort) : undefined;
  const bindHttpPort = "bindHttpPort" in value ? optionalNumber(value.bindHttpPort) : undefined;
  const bindHttpsPort = "bindHttpsPort" in value ? optionalNumber(value.bindHttpsPort) : undefined;
  return {
    ...(mode === undefined ? {} : { mode }),
    ...(httpPort === undefined ? {} : { httpPort }),
    ...(httpsPort === undefined ? {} : { httpsPort }),
    ...(bindHttpPort === undefined ? {} : { bindHttpPort }),
    ...(bindHttpsPort === undefined ? {} : { bindHttpsPort }),
  };
};

const pairFromPublish = (state: TraefikPublishState | undefined): LeftoverProxyPortPair => {
  const ports = resolveTraefikPublishPorts(state);
  return { httpPort: ports.http, httpsPort: ports.https };
};

const resolveRuntimeBinDir = (input: {
  readonly userDataRoot: string | undefined;
  readonly platform: HostPlatform;
}): Effect.Effect<string | undefined> => {
  if (input.userDataRoot === undefined) return Effect.succeed(undefined);
  const bin = makeLandoPaths({ userDataRoot: input.userDataRoot, platform: input.platform }).runtimeBinDir;
  return Effect.tryPromise(() => realpath(bin)).pipe(Effect.catch(() => Effect.succeed(bin)));
};

const resolveProbedPair = (
  input: { readonly userDataRoot: string | undefined; readonly platform: HostPlatform },
  override: LeftoverProxyPortPair | undefined,
): Effect.Effect<LeftoverProxyPortPair> => {
  if (override !== undefined) return Effect.succeed(override);
  if (input.userDataRoot === undefined) return Effect.succeed(LAST_FALLBACK);
  const paths: ProxyPaths = {
    platform: input.platform,
    globalAppRoot: globalAppRootPath(input.userDataRoot, input.platform),
    userDataRoot: input.userDataRoot,
  };
  return Effect.tryPromise(() => readFile(acquisitionStateFile(paths), "utf8")).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => publishStateFromUnknown(JSON.parse(text)),
        catch: (error) => error,
      }),
    ),
    Effect.map(pairFromPublish),
    Effect.catch(() => Effect.succeed(LAST_FALLBACK)),
  );
};

const leftoverReport = (leftover: ReadonlyArray<LoopbackPortSnapshot>): PluginDoctorReport => {
  const first = leftover[0];
  return {
    name: "proxy-loopback-ports",
    status: "warn",
    severity: "warn",
    runtimeStatus: "leftover-rootlessport",
    runtime: { running: false },
    context: {
      host: LOOPBACK_HOST,
      ports: leftover.map((item) => String(item.port)).join(","),
      holder: first?.comm ?? "rootlessport",
    },
    solutions: [
      {
        kind: "manual",
        description: "Stop the global app so leftover proxy loopback ports can be released.",
        command: "lando global:stop",
      },
      {
        kind: "manual",
        description:
          "If global:stop does not release the port, terminate the leftover rootlessport process manually before retrying.",
      },
      {
        kind: "manual",
        description: "If the managed runtime is broken after reaping, restore it and retry start.",
        command: "lando setup",
      },
    ],
  } satisfies PluginDoctorReport;
};

const otherDataRootReport = (holders: ReadonlyArray<LoopbackPortSnapshot>): PluginDoctorReport => {
  const first = holders[0];
  const ownerBin = first?.ownerRuntimeBinDir;
  return {
    name: "proxy-loopback-ports",
    status: "warn",
    severity: "warn",
    runtimeStatus: "other-data-root-forwarder",
    runtime: { running: true },
    context: {
      host: LOOPBACK_HOST,
      ports: holders.map((item) => String(item.port)).join(","),
      holder: first?.comm ?? "rootlessport",
      ...(ownerBin === undefined ? {} : { ownerRuntimeBinDir: ownerBin }),
      ...(first?.pid === undefined ? {} : { pid: String(first.pid) }),
    },
    solutions: [
      {
        kind: "manual",
        description:
          "Another Lando data root's live rootlessport forwarder holds these loopback ports. Do not terminate that process from this data root.",
      },
      {
        kind: "manual",
        description:
          ownerBin === undefined
            ? "Stop the other Lando install that owns the forwarder, or point this Lando at that data root (LANDO_USER_DATA_ROOT), or choose free router ports for this root."
            : `Stop the Lando install whose runtime bin is ${ownerBin}, or point this Lando at that data root (LANDO_USER_DATA_ROOT), or choose free router ports for this root.`,
      },
    ],
  } satisfies PluginDoctorReport;
};

export const makeLeftoverProxyPortsCheck = (
  readers: LoopbackPortReaders = systemReaders,
  ports?: LeftoverProxyPortPair,
): PluginDoctorCheckContribution => ({
  id: "proxy-loopback-ports",
  run: Effect.fnUntraced(function* (input) {
    const pair = yield* resolveProbedPair(input, ports);
    const runtimeBinDir = yield* resolveRuntimeBinDir(input);
    const probed: ReadonlyArray<{ readonly port: number; readonly role: LoopbackPortRole }> = [
      { port: pair.httpPort, role: "http" },
      { port: pair.httpsPort, role: "https" },
    ];
    const snapshots = yield* Effect.forEach(
      probed,
      ({ port, role }) =>
        Effect.promise(() =>
          readers.readPort(port, input.platform, role, runtimeBinDir).catch(() => idleSnapshot(port)),
        ),
      { concurrency: "unbounded" },
    );

    const leftover = snapshots.filter(isLeftoverRootlessportHolder);
    const otherRoot = snapshots.filter(isOtherDataRootForwarder);
    const reports: PluginDoctorReport[] = [];
    if (leftover[0] !== undefined) reports.push(leftoverReport(leftover));
    if (otherRoot[0] !== undefined) reports.push(otherDataRootReport(otherRoot));
    return reports;
  }),
});

export const leftoverProxyPortsCheck = makeLeftoverProxyPortsCheck();
