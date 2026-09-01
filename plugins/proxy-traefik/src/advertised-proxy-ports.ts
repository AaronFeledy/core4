import { readFile } from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import { Socket } from "node:net";

import { makeLandoPaths } from "@lando/paths";
import type { PluginDoctorCheckContribution, PluginDoctorReport } from "@lando/sdk/plugins";
import type { HostPlatform } from "@lando/sdk/schema";
import { Effect } from "effect";

import { DESIRED_HTTPS_PORT, DESIRED_HTTP_PORT } from "./port-acquisition.ts";
import { acquisitionStateFile } from "./proxy-paths.ts";
import type { ProxyPaths } from "./proxy-types.ts";

export type AdvertisedPortRole = "http" | "https";

export interface AdvertisedPortSnapshot {
  readonly port: number;
  readonly listening: boolean;
  readonly httpOk: boolean;
}

export interface AdvertisedPortReaders {
  readonly readPort: (port: number, role: AdvertisedPortRole) => Promise<AdvertisedPortSnapshot>;
}

export interface AdvertisedPortPair {
  readonly httpPort: number;
  readonly httpsPort: number;
}

const LOOPBACK_HOST = "127.0.0.1" as const;
const TCP_PROBE_MS = 200;
const HTTP_PROBE_MS = 500;
const LAST_FALLBACK: AdvertisedPortPair = { httpPort: DESIRED_HTTP_PORT, httpsPort: DESIRED_HTTPS_PORT };

const idle = (port: number): AdvertisedPortSnapshot => ({ port, listening: false, httpOk: false });

const probeTcp = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = new Socket();
    const finish = (open: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(TCP_PROBE_MS);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
    socket.connect(port, LOOPBACK_HOST);
  });

const probeHttp = (port: number, role: AdvertisedPortRole): Promise<boolean> =>
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

const readPort = async (port: number, role: AdvertisedPortRole): Promise<AdvertisedPortSnapshot> => {
  const listening = await probeTcp(port);
  if (!listening) return idle(port);
  return { port, listening: true, httpOk: await probeHttp(port, role) };
};

const systemReaders: AdvertisedPortReaders = { readPort };

const optionalNumber = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;

const advertisedPairFromUnknown = (value: unknown): AdvertisedPortPair => {
  if (typeof value !== "object" || value === null) return LAST_FALLBACK;
  const mode = "mode" in value && typeof value.mode === "string" ? value.mode : undefined;
  const socketsActive = "socketsActive" in value && value.socketsActive === true;
  if (mode === "socket-helper" || socketsActive) {
    return { httpPort: DESIRED_HTTP_PORT, httpsPort: DESIRED_HTTPS_PORT };
  }
  const httpPort = "httpPort" in value ? optionalNumber(value.httpPort) : undefined;
  const httpsPort = "httpsPort" in value ? optionalNumber(value.httpsPort) : undefined;
  if (httpPort === undefined || httpsPort === undefined) return LAST_FALLBACK;
  return { httpPort, httpsPort };
};

const resolveAdvertisedPair = (
  input: { readonly userDataRoot: string | undefined; readonly platform: HostPlatform },
  override: AdvertisedPortPair | undefined,
): Effect.Effect<AdvertisedPortPair> => {
  if (override !== undefined) return Effect.succeed(override);
  if (input.userDataRoot === undefined) return Effect.succeed(LAST_FALLBACK);
  const resolved = makeLandoPaths({ userDataRoot: input.userDataRoot, platform: input.platform });
  const paths: ProxyPaths = { platform: resolved.platform, globalAppRoot: resolved.globalAppRoot };
  return Effect.tryPromise(() => readFile(acquisitionStateFile(paths), "utf8")).pipe(
    Effect.map((text) => advertisedPairFromUnknown(JSON.parse(text))),
    Effect.catchAll(() => Effect.succeed(LAST_FALLBACK)),
  );
};

export const makeAdvertisedProxyPortsCheck = (
  readers: AdvertisedPortReaders = systemReaders,
  ports?: AdvertisedPortPair,
): PluginDoctorCheckContribution => ({
  id: "proxy-advertised-ports",
  run: (input) =>
    Effect.gen(function* () {
      const pair = yield* resolveAdvertisedPair(input, ports);
      const probed: ReadonlyArray<{ readonly port: number; readonly role: AdvertisedPortRole }> = [
        { port: pair.httpPort, role: "http" },
        { port: pair.httpsPort, role: "https" },
      ];
      const snapshots = yield* Effect.forEach(
        probed,
        ({ port, role }) => Effect.promise(() => readers.readPort(port, role).catch(() => idle(port))),
        { concurrency: "unbounded" },
      );
      const broken = snapshots.filter((item) => item.listening && !item.httpOk);
      if (broken[0] === undefined) return [];

      const report = {
        name: "proxy-advertised-ports",
        status: "warn",
        severity: "warn",
        runtimeStatus: "advertised-port-unhealthy",
        runtime: { running: false },
        context: {
          host: LOOPBACK_HOST,
          ports: broken.map((item) => String(item.port)).join(","),
        },
        solutions: [
          {
            kind: "manual",
            description: "Restart the global proxy so advertised URLs reach Traefik again.",
            command: "lando global:restart",
          },
          {
            kind: "manual",
            description: "If restart does not fix it, restore the managed runtime and retry.",
            command: "lando setup",
          },
        ],
      } satisfies PluginDoctorReport;

      return [report];
    }),
});

export const advertisedProxyPortsCheck = makeAdvertisedProxyPortsCheck();
