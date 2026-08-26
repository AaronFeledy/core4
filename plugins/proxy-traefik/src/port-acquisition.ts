import http from "node:http";
import https from "node:https";
import { Socket, createServer } from "node:net";

import { Duration, Effect } from "effect";

import { runProbe } from "@lando/sdk/probe";
import { createRedactor } from "@lando/sdk/secrets";

import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";
import type { ProxyPaths } from "./proxy-types.ts";

export const DESIRED_HTTP_PORT = 80;
export const DESIRED_HTTPS_PORT = 443;
export const LOOPBACK_HOST = "127.0.0.1" as const;

export const ACQUISITION_MODES = [
  "direct",
  "occupied-hop",
  "needs-helper",
  "socket-helper",
  "degraded-high-ports",
] as const;
export type AcquisitionMode = (typeof ACQUISITION_MODES)[number];

export type BindOutcome =
  | { readonly kind: "success" }
  | { readonly kind: "EADDRINUSE"; readonly code: "EADDRINUSE" }
  | { readonly kind: "EACCES"; readonly code: "EACCES" | "EPERM" }
  | { readonly kind: "other-error"; readonly code?: string };

export type ForwardOutcome = { readonly kind: "success" } | { readonly kind: "failure" };

export type SchemeProbe = {
  readonly bind: BindOutcome;
  readonly forward: ForwardOutcome;
  readonly holder?: string;
};

export type ClassifyAcquisitionInput = {
  readonly platform: ProxyPaths["platform"];
  readonly http: SchemeProbe;
  readonly https: SchemeProbe;
  readonly helperInstalled: boolean;
  readonly socketsActive: boolean;
};

export type AcquisitionDecision = {
  readonly mode: AcquisitionMode;
  readonly httpPort: typeof DESIRED_HTTP_PORT | typeof TRAEFIK_HTTP_PORT;
  readonly httpsPort: typeof DESIRED_HTTPS_PORT | typeof TRAEFIK_HTTPS_PORT;
  readonly notices: readonly string[];
};

const MODE_RANK = {
  "occupied-hop": 0,
  "needs-helper": 1,
  "socket-helper": 2,
  "degraded-high-ports": 3,
  direct: 4,
} as const;

const secretsRedactor = createRedactor("secrets");

const isLinuxFamily = (platform: ProxyPaths["platform"]): boolean =>
  platform === "linux" || platform === "wsl";

const errnoCode = (error: unknown): string | undefined => {
  if (typeof error === "object" && error !== null && "code" in error && typeof error.code === "string") {
    return error.code;
  }
  return undefined;
};

const classifyBindError = (error: unknown): BindOutcome => {
  const code = errnoCode(error);
  if (code === "EADDRINUSE") return { kind: "EADDRINUSE", code: "EADDRINUSE" };
  if (code === "EACCES" || code === "EPERM") return { kind: "EACCES", code };
  return { kind: "other-error", ...(code === undefined ? {} : { code }) };
};

const isBindOutcome = (value: unknown): value is BindOutcome => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  const kind = value.kind;
  return kind === "success" || kind === "EADDRINUSE" || kind === "EACCES" || kind === "other-error";
};

const isForwardOutcome = (value: unknown): value is ForwardOutcome => {
  if (typeof value !== "object" || value === null || !("kind" in value)) return false;
  return value.kind === "success" || value.kind === "failure";
};

type SchemeDecision = {
  readonly mode: AcquisitionMode;
  readonly port: number;
  readonly notice?: string;
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
};

const classifyScheme = (
  input: ClassifyAcquisitionInput,
  scheme: SchemeProbe,
  ports: { readonly privileged: number; readonly high: number },
): SchemeDecision => {
  switch (scheme.forward.kind) {
    case "success":
      return { mode: "direct", port: ports.privileged };
    case "failure":
      break;
    default:
      return assertNever(scheme.forward);
  }
  switch (scheme.bind.kind) {
    case "success":
      return { mode: "direct", port: ports.privileged };
    case "EADDRINUSE":
      return {
        mode: "occupied-hop",
        port: ports.high,
        ...(scheme.holder === undefined ? {} : { notice: `occupied-hop holder=${scheme.holder}` }),
      };
    case "EACCES":
      if (!isLinuxFamily(input.platform)) {
        return { mode: "degraded-high-ports", port: ports.high };
      }
      if (input.helperInstalled) {
        return { mode: "socket-helper", port: ports.privileged };
      }
      return { mode: "needs-helper", port: ports.high };
    case "other-error":
      return { mode: "degraded-high-ports", port: ports.high };
    default:
      return assertNever(scheme.bind);
  }
};

const pickMode = (left: AcquisitionMode, right: AcquisitionMode): AcquisitionMode =>
  MODE_RANK[left] <= MODE_RANK[right] ? left : right;

export const classifyAcquisition = (input: ClassifyAcquisitionInput): AcquisitionDecision => {
  const http = classifyScheme(input, input.http, { privileged: DESIRED_HTTP_PORT, high: TRAEFIK_HTTP_PORT });
  const https = classifyScheme(input, input.https, {
    privileged: DESIRED_HTTPS_PORT,
    high: TRAEFIK_HTTPS_PORT,
  });
  const notices = [http.notice, https.notice].filter((notice): notice is string => notice !== undefined);
  return {
    mode: pickMode(http.mode, https.mode),
    httpPort: http.port === DESIRED_HTTP_PORT ? DESIRED_HTTP_PORT : TRAEFIK_HTTP_PORT,
    httpsPort: https.port === DESIRED_HTTPS_PORT ? DESIRED_HTTPS_PORT : TRAEFIK_HTTPS_PORT,
    notices,
  };
};

const listenOnce = (host: string, port: number): Promise<BindOutcome> =>
  new Promise((resolve) => {
    const server = createServer();
    const finish = (outcome: BindOutcome) => {
      server.removeAllListeners();
      if (server.listening) {
        server.close(() => resolve(outcome));
        return;
      }
      resolve(outcome);
    };
    server.once("error", (error) => finish(classifyBindError(error)));
    server.listen(port, host, () => finish({ kind: "success" }));
  });

export const probeBind = (host: string, port: number): Effect.Effect<BindOutcome> =>
  Effect.gen(function* () {
    let last: BindOutcome = { kind: "other-error" };
    yield* runProbe(
      {
        id: "proxy-traefik-bind",
        policy: { maxAttempts: 3, delay: Duration.millis(25) },
        classify: {
          success: (value) => {
            if (isBindOutcome(value)) last = value;
            return last.kind === "other-error" ? "yellow" : "green";
          },
          failure: (error) => {
            last = classifyBindError(secretsRedactor.redactValue(error));
            return last.kind === "other-error" ? "yellow" : "green";
          },
        },
      },
      Effect.tryPromise({
        try: () => listenOnce(host, port),
        catch: (error) => error,
      }),
    ).pipe(Effect.catchAll(() => Effect.void));
    return last;
  });

const probeTcp = (host: string, port: number): Promise<"open" | "closed"> =>
  new Promise((resolve) => {
    const socket = new Socket();
    const finish = (result: "open" | "closed") => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(200);
    socket.once("connect", () => finish("open"));
    socket.once("timeout", () => finish("closed"));
    socket.once("error", () => finish("closed"));
    socket.connect(port, host);
  });

const probeHttp = (host: string, port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const transport = port === DESIRED_HTTPS_PORT ? https : http;
    const request = transport.request(
      { host, port, path: "/", method: "GET", timeout: 500, rejectUnauthorized: false },
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

const forwardOnce = async (host: string, port: number): Promise<ForwardOutcome> => {
  const tcp = await probeTcp(host, port);
  if (tcp !== "open") return { kind: "failure" };
  return { kind: (await probeHttp(host, port)) ? "success" : "failure" };
};

export const probeForward = (host: string, port: number): Effect.Effect<ForwardOutcome> =>
  Effect.gen(function* () {
    let last: ForwardOutcome = { kind: "failure" };
    yield* runProbe(
      {
        id: "proxy-traefik-forward",
        policy: { maxAttempts: 3, delay: Duration.millis(50), timeout: Duration.millis(1000) },
        classify: {
          success: (value) => {
            if (isForwardOutcome(value)) last = value;
            return last.kind === "success" ? "green" : "yellow";
          },
          failure: (error) => {
            last = { kind: "failure" };
            void secretsRedactor.redactValue(error);
            return "yellow";
          },
        },
      },
      Effect.tryPromise({
        try: () => forwardOnce(host, port),
        catch: (error) => error,
      }),
    ).pipe(Effect.catchAll((error) => Effect.sync(() => void secretsRedactor.redactValue(error))));
    return last;
  });
