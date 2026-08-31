import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";

import { makeLandoPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import type { HostPlatform } from "@lando/sdk/schema";
import { Effect } from "effect";

import { type TraefikPublishState, resolveTraefikPublishPorts } from "./global-services/traefik.ts";
import { commLooksLikeRootlessport, identifyLoopbackHolderComm } from "./leftover-proxy-ports-linux.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";
import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";

export type LoopbackPortKind = "leftover-rootlessport" | "healthy-proxy" | "foreign" | "unknown";
export type LoopbackPortRole = "http" | "https";

export interface LoopbackPortSnapshot {
  readonly port: number;
  readonly host: "127.0.0.1";
  readonly listening: boolean;
  readonly comm?: string;
  readonly kind?: LoopbackPortKind;
}

export interface LoopbackPortReaders {
  readonly readPort: (
    port: number,
    platform: HostPlatform,
    role?: LoopbackPortRole,
  ) => Promise<LoopbackPortSnapshot>;
}

export interface LeftoverProxyPortPair {
  readonly httpPort: number;
  readonly httpsPort: number;
}

const LOOPBACK_HOST = "127.0.0.1" as const;
const TCP_PROBE_MS = 200;
const HTTP_PROBE_MS = 500;
const LAST_FALLBACK: LeftoverProxyPortPair = {
  httpPort: TRAEFIK_HTTP_PORT,
  httpsPort: TRAEFIK_HTTPS_PORT,
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
};

const isLeftoverRootlessportHolder = (snapshot: LoopbackPortSnapshot): boolean =>
  snapshot.listening && snapshot.kind === "leftover-rootlessport";

const idleSnapshot = (port: number): LoopbackPortSnapshot => ({
  port,
  host: LOOPBACK_HOST,
  listening: false,
});

type TcpProbe = "refused" | "open" | "unknown";

const probeTcp = (port: number): Promise<TcpProbe> =>
  new Promise((resolve) => {
    const socket = new Socket();
    const finish = (result: TcpProbe) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(TCP_PROBE_MS);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("unknown"));
    socket.once("error", (error: Error) => {
      const code = "code" in error && typeof error.code === "string" ? error.code : undefined;
      finish(code === "ECONNREFUSED" ? "refused" : "unknown");
    });
    socket.connect(port, LOOPBACK_HOST);
  });

const probeHttp = (port: number, role: LoopbackPortRole): Promise<boolean> =>
  new Promise((resolve) => {
    const request = (role === "https" ? https : http).request(
      {
        host: LOOPBACK_HOST,
        port,
        path: "/",
        method: "GET",
        timeout: HTTP_PROBE_MS,
        rejectUnauthorized: false,
      },
      (response) => {
        response.resume();
        resolve(response.statusCode !== undefined);
      },
    );
    request.once("timeout", () => {
      request.destroy();
      resolve(false);
    });
    request.once("error", () => resolve(false));
    request.end();
  });

const readPort = async (
  port: number,
  platform: HostPlatform,
  role: LoopbackPortRole = "http",
): Promise<LoopbackPortSnapshot> => {
  if (platform !== "linux" && platform !== "wsl") return idleSnapshot(port);

  const tcp = await probeTcp(port);
  switch (tcp) {
    case "refused":
      return idleSnapshot(port);
    case "unknown":
      return { port, host: LOOPBACK_HOST, listening: true, kind: "unknown" };
    case "open":
      break;
    default:
      return assertNever(tcp);
  }

  if (await probeHttp(port, role)) {
    return { port, host: LOOPBACK_HOST, listening: true, kind: "healthy-proxy" };
  }

  const comm = await identifyLoopbackHolderComm(port);
  if (comm !== undefined && commLooksLikeRootlessport(comm)) {
    return { port, host: LOOPBACK_HOST, listening: true, comm, kind: "leftover-rootlessport" };
  }
  if (comm !== undefined) {
    return { port, host: LOOPBACK_HOST, listening: true, comm, kind: "foreign" };
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

const resolveProbedPair = (
  input: { readonly userDataRoot: string | undefined; readonly platform: HostPlatform },
  override: LeftoverProxyPortPair | undefined,
): Effect.Effect<LeftoverProxyPortPair> => {
  if (override !== undefined) return Effect.succeed(override);
  if (input.userDataRoot === undefined) return Effect.succeed(LAST_FALLBACK);
  const resolved = makeLandoPaths({ userDataRoot: input.userDataRoot, platform: input.platform });
  const paths: ProxyPaths = { platform: resolved.platform, globalAppRoot: resolved.globalAppRoot };
  return Effect.tryPromise(() => readFile(acquisitionStateFile(paths), "utf8")).pipe(
    Effect.flatMap((text) =>
      Effect.try({
        try: () => publishStateFromUnknown(JSON.parse(text)),
        catch: (error) => error,
      }),
    ),
    Effect.map(pairFromPublish),
    Effect.catchAll(() => Effect.succeed(LAST_FALLBACK)),
  );
};

export const makeLeftoverProxyPortsCheck = (
  readers: LoopbackPortReaders = systemReaders,
  ports?: LeftoverProxyPortPair,
): PluginDoctorCheckContribution => ({
  id: "proxy-loopback-ports",
  run: (input) =>
    Effect.gen(function* () {
      const pair = yield* resolveProbedPair(input, ports);
      const probed: ReadonlyArray<{ readonly port: number; readonly role: LoopbackPortRole }> = [
        { port: pair.httpPort, role: "http" },
        { port: pair.httpsPort, role: "https" },
      ];
      const snapshots = yield* Effect.forEach(
        probed,
        ({ port, role }) =>
          Effect.promise(() => readers.readPort(port, input.platform, role).catch(() => idleSnapshot(port))),
        { concurrency: "unbounded" },
      );

      const leftover = snapshots.filter(isLeftoverRootlessportHolder);
      const first = leftover[0];
      if (first === undefined) return [];

      const report = {
        name: "proxy-loopback-ports",
        status: "warn",
        severity: "warn",
        runtimeStatus: "leftover-rootlessport",
        runtime: { running: false },
        context: {
          host: LOOPBACK_HOST,
          ports: leftover.map((item) => String(item.port)).join(","),
          holder: first.comm ?? "rootlessport",
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

      return [report];
    }),
});

export const leftoverProxyPortsCheck = makeLeftoverProxyPortsCheck();
