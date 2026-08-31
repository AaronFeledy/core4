import { RouterPortsExhausted } from "@lando/sdk/errors";
import type { PortNumber } from "@lando/sdk/schema";
import { commLooksLikeRootlessport } from "./leftover-proxy-ports-linux.ts";
import type { ProxyPaths } from "./proxy-types.ts";

export const DESIRED_HTTP_PORT = 80;
export const DESIRED_HTTPS_PORT = 443;
export const LOOPBACK_HOST = "127.0.0.1" as const;

export const DEFAULT_HTTP_TRY_LIST = [80, 8080, 8000, 8888, 8008, 38080] as const;
export const DEFAULT_HTTPS_TRY_LIST = [443, 8443, 4443, 4433, 4444, 444, 38443] as const;

export const ACQUISITION_MODES = ["direct", "occupied-hop", "needs-helper", "socket-helper"] as const;
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

export type AcquisitionFingerprint = {
  readonly http: readonly number[];
  readonly https: readonly number[];
  readonly bindAddress: string;
};

export type ClassifyAcquisitionInput = {
  readonly platform: ProxyPaths["platform"];
  readonly http: SchemeProbe;
  readonly https: SchemeProbe;
  readonly helperInstalled: boolean;
  readonly socketsActive: boolean;
  readonly httpBinds?: Readonly<Record<number, BindOutcome>>;
  readonly httpsBinds?: Readonly<Record<number, BindOutcome>>;
  readonly httpTryList?: readonly number[];
  readonly httpsTryList?: readonly number[];
  readonly bindAddress?: string;
};

export type AcquisitionDecision = {
  readonly mode: AcquisitionMode;
  readonly httpPort: PortNumber;
  readonly httpsPort: PortNumber;
  readonly notices: readonly string[];
  readonly fingerprint: AcquisitionFingerprint;
};

const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`);
};

export const isOurLoopbackForwarder = (holder: string): boolean => {
  const name = holder.toLowerCase();
  return (
    commLooksLikeRootlessport(holder) ||
    name.includes("docker-proxy") ||
    name.includes("rootlesskit") ||
    name.includes("systemd-socket-proxyd") ||
    name === "traefik"
  );
};

export const defaultAcquisitionFingerprint = (
  bindAddress: string = LOOPBACK_HOST,
): AcquisitionFingerprint => ({
  http: [...DEFAULT_HTTP_TRY_LIST],
  https: [...DEFAULT_HTTPS_TRY_LIST],
  bindAddress,
});

type ProtocolWalk =
  | {
      readonly kind: "chosen";
      readonly port: number;
      readonly preferredOccupied: boolean;
      readonly holder?: string;
    }
  | { readonly kind: "exhausted" };

const walkProtocol = (
  tryList: readonly number[],
  preferred: number,
  binds: Readonly<Record<number, BindOutcome>> | undefined,
  scheme: SchemeProbe,
): ProtocolWalk => {
  let preferredOccupied = false;
  let holder: string | undefined;
  for (const port of tryList) {
    const outcome = binds?.[port] ?? (port === preferred ? scheme.bind : undefined);
    if (outcome === undefined) continue;
    switch (outcome.kind) {
      case "success":
        return {
          kind: "chosen",
          port,
          preferredOccupied,
          ...(holder === undefined ? {} : { holder }),
        };
      case "EADDRINUSE":
        if (port === preferred) {
          preferredOccupied = true;
          holder = scheme.holder;
        }
        continue;
      case "EACCES":
      case "other-error":
        continue;
      default:
        return assertNever(outcome);
    }
  }
  return { kind: "exhausted" };
};

export const FALLBACK_RESTORE =
  "Stop the holder then run `lando global:restart` (or re-run setup) to restore 80/443.";

const occupiedHopNotice = (preferred: number, chosen: number, holder: string | undefined): string => {
  const who = holder ?? "another process";
  return `Port ${preferred} is occupied by ${who}; using ${chosen}. ${FALLBACK_RESTORE}`;
};

const portsExhausted = (input: {
  readonly bindAddress: string;
  readonly httpTried: readonly number[];
  readonly httpsTried: readonly number[];
  readonly exhausted: "http" | "https" | "both";
}): RouterPortsExhausted =>
  new RouterPortsExhausted({
    message: "No free host port remained on the router try list.",
    proxyId: "traefik",
    bindAddress: input.bindAddress,
    httpTried: [...input.httpTried],
    httpsTried: [...input.httpsTried],
    exhausted: input.exhausted,
    remediation:
      "Set router.httpPort, router.httpsPort, or router.httpFallbacks / router.httpsFallbacks to unused host ports.",
  });

export const classifyAcquisition = (input: ClassifyAcquisitionInput): AcquisitionDecision => {
  const httpTryList = input.httpTryList ?? DEFAULT_HTTP_TRY_LIST;
  const httpsTryList = input.httpsTryList ?? DEFAULT_HTTPS_TRY_LIST;
  const bindAddress = input.bindAddress ?? LOOPBACK_HOST;
  const preferredHttp = httpTryList[0] ?? DESIRED_HTTP_PORT;
  const preferredHttps = httpsTryList[0] ?? DESIRED_HTTPS_PORT;
  const http = walkProtocol(httpTryList, preferredHttp, input.httpBinds, input.http);
  const https = walkProtocol(httpsTryList, preferredHttps, input.httpsBinds, input.https);
  if (http.kind === "exhausted" || https.kind === "exhausted") {
    let exhausted: "http" | "https" | "both";
    if (http.kind === "exhausted" && https.kind === "exhausted") {
      exhausted = "both";
    } else if (http.kind === "exhausted") {
      exhausted = "http";
    } else {
      exhausted = "https";
    }
    throw portsExhausted({
      bindAddress,
      httpTried: httpTryList,
      httpsTried: httpsTryList,
      exhausted,
    });
  }
  const notices = [
    http.preferredOccupied ? occupiedHopNotice(preferredHttp, http.port, http.holder) : undefined,
    https.preferredOccupied ? occupiedHopNotice(preferredHttps, https.port, https.holder) : undefined,
  ].filter((notice): notice is string => notice !== undefined);
  const fallbackChosen = http.port !== preferredHttp || https.port !== preferredHttps;
  return {
    mode: fallbackChosen ? "occupied-hop" : "direct",
    httpPort: http.port,
    httpsPort: https.port,
    notices,
    fingerprint: {
      http: [...httpTryList],
      https: [...httpsTryList],
      bindAddress,
    },
  };
};

const firstHighSuccess = (
  tryList: readonly number[],
  preferred: number,
  binds: Readonly<Record<number, BindOutcome>> | undefined,
): number | undefined => {
  for (const port of tryList) {
    if (port === preferred) continue;
    const outcome = binds?.[port];
    if (outcome?.kind === "success") return port;
  }
  return undefined;
};

export const chooseHelperBindPorts = (input: {
  readonly httpBinds?: Readonly<Record<number, BindOutcome>>;
  readonly httpsBinds?: Readonly<Record<number, BindOutcome>>;
  readonly httpTryList?: readonly number[];
  readonly httpsTryList?: readonly number[];
}): { readonly bindHttpPort: number; readonly bindHttpsPort: number } => {
  const httpTryList = input.httpTryList ?? DEFAULT_HTTP_TRY_LIST;
  const httpsTryList = input.httpsTryList ?? DEFAULT_HTTPS_TRY_LIST;
  const preferredHttp = httpTryList[0] ?? DESIRED_HTTP_PORT;
  const preferredHttps = httpsTryList[0] ?? DESIRED_HTTPS_PORT;
  const bindHttpPort = firstHighSuccess(httpTryList, preferredHttp, input.httpBinds);
  const bindHttpsPort = firstHighSuccess(httpsTryList, preferredHttps, input.httpsBinds);
  if (bindHttpPort === undefined || bindHttpsPort === undefined) {
    throw portsExhausted({
      bindAddress: LOOPBACK_HOST,
      httpTried: httpTryList,
      httpsTried: httpsTryList,
      exhausted:
        bindHttpPort === undefined && bindHttpsPort === undefined
          ? "both"
          : bindHttpPort === undefined
            ? "http"
            : "https",
    });
  }
  return { bindHttpPort, bindHttpsPort };
};

export { probeBind, probeForward, probeTcpOpen } from "./port-acquisition-bind.ts";
