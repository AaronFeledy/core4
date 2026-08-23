import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";

import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import type { HostPlatform } from "@lando/sdk/schema";
import { Effect } from "effect";

import { commLooksLikeRootlessport, identifyLoopbackHolderComm } from "./leftover-proxy-ports-linux.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";

export type LoopbackPortKind = "leftover-rootlessport" | "healthy-proxy" | "foreign" | "unknown";

export interface LoopbackPortSnapshot {
  readonly port: number;
  readonly host: "127.0.0.1";
  readonly listening: boolean;
  readonly comm?: string;
  readonly kind?: LoopbackPortKind;
}

export interface LoopbackPortReaders {
  readonly readPort: (port: number, platform: HostPlatform) => Promise<LoopbackPortSnapshot>;
}

const LOOPBACK_HOST = "127.0.0.1" as const;
const TCP_PROBE_MS = 200;
const HTTP_PROBE_MS = 500;
const PROBED_PORTS = [TRAEFIK_HTTP_PORT, TRAEFIK_HTTPS_PORT] as const;

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
};

export { commLooksLikeRootlessport } from "./leftover-proxy-ports-linux.ts";

export const isLeftoverRootlessportHolder = (snapshot: LoopbackPortSnapshot): boolean => {
  if (!snapshot.listening) return false;
  const kind = snapshot.kind;
  if (kind === undefined) {
    return snapshot.comm !== undefined && commLooksLikeRootlessport(snapshot.comm);
  }
  switch (kind) {
    case "leftover-rootlessport":
      return true;
    case "healthy-proxy":
    case "foreign":
    case "unknown":
      return false;
    default:
      return assertNever(kind);
  }
};

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

const probeHttp = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const request = (port === TRAEFIK_HTTPS_PORT ? https : http).request(
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

const readPort = async (port: number, platform: HostPlatform): Promise<LoopbackPortSnapshot> => {
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

  if (await probeHttp(port)) {
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

export const makeLeftoverProxyPortsCheck = (
  readers: LoopbackPortReaders = systemReaders,
): PluginDoctorCheckContribution => ({
  id: "proxy-loopback-ports",
  run: (input) =>
    Effect.gen(function* () {
      const snapshots = yield* Effect.forEach(
        PROBED_PORTS,
        (port) =>
          Effect.tryPromise({
            try: () => readers.readPort(port, input.platform),
            catch: (): LoopbackPortSnapshot => ({ port, host: "127.0.0.1", listening: false }),
          }).pipe(Effect.catchAll((snapshot) => Effect.succeed(snapshot))),
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
