import type { HostChangeStepRunner, ProcessResult, ProcessRunner } from "@lando/sdk/services";
import { type Context, Effect } from "effect";

import {
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  type ForwardOutcome,
  type ForwardProbeRole,
  probeForward,
} from "./port-acquisition.ts";
import { ProxydBinaryNotFound } from "./socket-proxy-errors.ts";
import {
  SOCKET_PROXY_EXIT_FOREIGN,
  SOCKET_PROXY_EXIT_NEEDS_FLOCK,
  SOCKET_PROXY_EXIT_SYMLINK,
  socketProxyPolkitHeader,
  socketProxyUnitHeader,
} from "./socket-proxy-helper.ts";
import { type HostPathAccess, classifySocketProxy, inspectSocketProxy } from "./socket-proxy-ownership.ts";
import { shQuote, socketProxyArtifactRecheck, socketProxyLockPreamble } from "./socket-proxy-script.ts";
import {
  POLKIT_RULE_PATH,
  PROXYD_CANDIDATES,
  SOCKET_UNIT_PATHS,
  type SocketProxyServiceType,
  buildInstallScript,
  renderPolkitRule,
} from "./socket-proxy-units.ts";

export { ProxydBinaryNotFound } from "./socket-proxy-errors.ts";
export { classifySocketProxy } from "./socket-proxy-ownership.ts";
export { POLKIT_RULE_PATH, PROXYD_CANDIDATES, SOCKET_UNIT_PATHS, renderPolkitRule };

const failedResult = (exitCode = 1, stderr = ""): ProcessResult => ({ exitCode, stdout: "", stderr });

export interface DiscoverProxydInput {
  readonly exists: HostPathAccess["exists"];
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
}

/** What the elevated install script reported. */
export type SocketProxyInstallOutcome =
  | { readonly kind: "installed" }
  | { readonly kind: "foreign" }
  | {
      readonly kind: "needs-helper";
      readonly reason: "flock-missing" | "symlink";
      readonly exitCode: number;
      readonly stderr: string;
    }
  | { readonly kind: "elevation-refused"; readonly exitCode: number; readonly stderr: string };

export type SocketProxyStartOutcome =
  | { readonly kind: "started"; readonly http: ForwardOutcome; readonly https: ForwardOutcome }
  | { readonly kind: "failed"; readonly exitCode: number; readonly stderr: string };

export interface InstallSocketProxyInput extends HostPathAccess {
  readonly user: string;
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly serviceType?: SocketProxyServiceType;
  readonly httpTarget: number;
  readonly httpsTarget: number;
  /** Replace a classified foreign helper (missing-root / confirmed unattributed) after digest pin. */
  readonly replaceForeign?: boolean;
  /** Rewrite this data root's helper even when its hops already match, to repair its grant. */
  readonly rewriteMatching?: boolean;
}

export interface StartSocketsInput extends HostPathAccess {
  readonly processRunner: Context.Service.Shape<typeof ProcessRunner>;
  readonly probeForward?: (
    host: string,
    port: number,
    role: ForwardProbeRole,
  ) => Effect.Effect<ForwardOutcome>;
}

const SOCKET_UNITS = ["lando-proxy-http.socket", "lando-proxy-https.socket"] as const;
const HTTP_SERVICE_PATH = "/etc/systemd/system/lando-proxy-http.service";
const HTTPS_SERVICE_PATH = "/etc/systemd/system/lando-proxy-https.service";

export const discoverProxydBinary = Effect.fn("SocketProxy.discoverProxydBinary")(function* (
  input: DiscoverProxydInput,
) {
  for (const candidate of PROXYD_CANDIDATES) {
    if (yield* input.exists(candidate)) return candidate;
  }
  const lookup = yield* input.processRunner
    .run({ cmd: "sh", args: ["-c", "command -v systemd-socket-proxyd"] })
    .pipe(Effect.catch(() => Effect.succeed(failedResult(1))));
  const found = lookup.stdout.trim();
  if (lookup.exitCode === 0 && found.length > 0) return found;
  return yield* Effect.fail(
    new ProxydBinaryNotFound({
      message: "systemd-socket-proxyd is not installed on this host.",
      remediation: "Install systemd (systemd-socket-proxyd) or continue with high-port Traefik authorities.",
    }),
  );
});

export const isSocketProxyInstalled = Effect.fnUntraced(function* (access: HostPathAccess) {
  if ((yield* classifySocketProxy(access)).kind !== "owned") return false;
  for (const path of SOCKET_UNIT_PATHS) {
    if (!(yield* access.exists(path))) return false;
  }
  return true;
});

const hopTargetPattern = (port: number): RegExp => new RegExp(`127\\.0\\.0\\.1:${port}(?!\\d)`, "u");

const hopPortFromUnit = (text: string): number | undefined => {
  const match = /127\.0\.0\.1:(\d+)/u.exec(text);
  const raw = match?.[1];
  if (raw === undefined) return undefined;
  const port = Number(raw);
  return Number.isSafeInteger(port) && port > 0 ? port : undefined;
};

export const readHelperHopTargets = Effect.fnUntraced(function* (access: HostPathAccess) {
  if ((yield* classifySocketProxy(access)).kind !== "owned") return undefined;
  const httpUnit = yield* access.readText(HTTP_SERVICE_PATH).pipe(Effect.catch(() => Effect.succeed("")));
  const httpsUnit = yield* access.readText(HTTPS_SERVICE_PATH).pipe(Effect.catch(() => Effect.succeed("")));
  const httpTarget = hopPortFromUnit(httpUnit);
  const httpsTarget = hopPortFromUnit(httpsUnit);
  if (httpTarget === undefined || httpsTarget === undefined) return undefined;
  return { httpTarget, httpsTarget };
});

/** Hop targets from any readable service units (for foreign replacement free-port checks). */
export const readAnyHelperHopTargets = Effect.fnUntraced(function* (access: HostPathAccess) {
  const httpUnit = yield* access.readText(HTTP_SERVICE_PATH).pipe(Effect.catch(() => Effect.succeed("")));
  const httpsUnit = yield* access.readText(HTTPS_SERVICE_PATH).pipe(Effect.catch(() => Effect.succeed("")));
  const httpTarget = hopPortFromUnit(httpUnit);
  const httpsTarget = hopPortFromUnit(httpsUnit);
  if (httpTarget === undefined || httpsTarget === undefined) return undefined;
  return { httpTarget, httpsTarget };
});

export const hopsMatchTargets = Effect.fnUntraced(function* (
  access: HostPathAccess,
  httpTarget: number,
  httpsTarget: number,
) {
  const httpUnit = yield* access.readText(HTTP_SERVICE_PATH).pipe(Effect.catch(() => Effect.succeed("")));
  const httpsUnit = yield* access.readText(HTTPS_SERVICE_PATH).pipe(Effect.catch(() => Effect.succeed("")));
  return hopTargetPattern(httpTarget).test(httpUnit) && hopTargetPattern(httpsTarget).test(httpsUnit);
});

export const SOCKET_PROXY_INSTALL_STEP = "install";

const mapElevatedInstall = (elevated: ProcessResult): SocketProxyInstallOutcome => {
  if (elevated.exitCode === 0) return { kind: "installed" };
  if (elevated.exitCode === SOCKET_PROXY_EXIT_FOREIGN) return { kind: "foreign" };
  if (elevated.exitCode === SOCKET_PROXY_EXIT_NEEDS_FLOCK) {
    return {
      kind: "needs-helper",
      reason: "flock-missing",
      exitCode: elevated.exitCode,
      stderr: elevated.stderr,
    };
  }
  if (elevated.exitCode === SOCKET_PROXY_EXIT_SYMLINK) {
    return {
      kind: "needs-helper",
      reason: "symlink",
      exitCode: elevated.exitCode,
      stderr: elevated.stderr,
    };
  }
  return { kind: "elevation-refused", exitCode: elevated.exitCode, stderr: elevated.stderr };
};

/** What installing the helper with these hops would do, decided read-only. */
export type SocketProxyInstallInspection =
  | { readonly kind: "already-installed" }
  | { readonly kind: "foreign" }
  | { readonly kind: "proxyd-missing" }
  | { readonly kind: "script"; readonly script: string };

export const inspectSocketProxyInstall = Effect.fn("SocketProxy.inspectSocketProxyInstall")(function* (
  input: InstallSocketProxyInput,
): Effect.fn.Return<SocketProxyInstallInspection> {
  const inspection = yield* inspectSocketProxy(input);
  const ownership = inspection.ownership;
  if (input.replaceForeign !== true) {
    if (ownership.kind === "foreign" || ownership.kind === "unmarked") return { kind: "foreign" };
    if (input.rewriteMatching !== true && (yield* isSocketProxyInstalled(input))) {
      if (yield* hopsMatchTargets(input, input.httpTarget, input.httpsTarget)) {
        return { kind: "already-installed" };
      }
    }
  } else if (ownership.kind === "owned") {
    if (
      (yield* isSocketProxyInstalled(input)) &&
      (yield* hopsMatchTargets(input, input.httpTarget, input.httpsTarget))
    ) {
      return { kind: "already-installed" };
    }
  } else if (ownership.kind === "unmarked") {
    return { kind: "foreign" };
  } else if (ownership.kind === "foreign") {
    if (ownership.reason === "other-root" || ownership.reason === "mixed") {
      return { kind: "foreign" };
    }
  }
  const binary = yield* discoverProxydBinary(input).pipe(
    Effect.catchTag("ProxydBinaryNotFound", () => Effect.succeed(undefined)),
  );
  if (binary === undefined) return { kind: "proxyd-missing" };
  const script = buildInstallScript({
    user: input.user,
    userDataRoot: inspection.currentRoot,
    binary,
    serviceType: input.serviceType ?? "notify",
    httpTarget: input.httpTarget,
    httpsTarget: input.httpsTarget,
    priorDigests: inspection.digests,
    replaceForeign: input.replaceForeign === true,
    ...(ownership.kind === "foreign" && ownership.ownerRoot !== undefined
      ? { priorOwnerRoot: ownership.ownerRoot }
      : {}),
  });
  return { kind: "script", script };
});

/** The install script runs as root through the run's administrator session, once. */
export const runSocketProxyInstall = (steps: HostChangeStepRunner) =>
  steps.run(SOCKET_PROXY_INSTALL_STEP).pipe(Effect.map(mapElevatedInstall));

const controlSockets = Effect.fn("SocketProxy.controlSockets")(function* (
  verb: "start" | "stop",
  input: StartSocketsInput,
): Effect.fn.Return<SocketProxyStartOutcome> {
  const units =
    verb === "stop" ? SOCKET_UNIT_PATHS.map((path) => path.slice(path.lastIndexOf("/") + 1)) : SOCKET_UNITS;
  const snapshot = yield* inspectSocketProxy(input);
  if (snapshot.ownership.kind !== "owned") {
    return {
      kind: "failed",
      exitCode: SOCKET_PROXY_EXIT_FOREIGN,
      stderr: "Socket proxy ownership changed; run lando doctor.",
    };
  }
  const checks = [...SOCKET_UNIT_PATHS, POLKIT_RULE_PATH].map((path) =>
    socketProxyArtifactRecheck({
      path,
      priorDigest: snapshot.digests[path],
      header:
        path === POLKIT_RULE_PATH
          ? socketProxyPolkitHeader(snapshot.currentRoot)
          : socketProxyUnitHeader(snapshot.currentRoot),
      allowUnknownDigest: path === POLKIT_RULE_PATH,
      allowUnattributed: false,
    }),
  );
  const script = [
    ...socketProxyLockPreamble,
    ...checks,
    `systemctl ${verb} ${units.map(shQuote).join(" ")}`,
  ].join("\n");
  // Only through the helper's polkit grant: starting or stopping it as root is an approved host
  // change, never a fallback here.
  const result = yield* input.processRunner
    .run({ cmd: "/bin/sh", args: ["-c", script] })
    .pipe(Effect.catch((error) => Effect.succeed(failedResult(1, error.message))));
  if (result.exitCode !== 0) {
    return { kind: "failed", exitCode: result.exitCode, stderr: result.stderr };
  }
  return yield* probeSocketProxy(input);
});

export const probeSocketProxy = Effect.fnUntraced(function* (
  input: Pick<StartSocketsInput, "probeForward">,
): Effect.fn.Return<SocketProxyStartOutcome> {
  const probe = input.probeForward ?? probeForward;
  const http = yield* probe("127.0.0.1", DESIRED_HTTP_PORT, "http");
  const https = yield* probe("127.0.0.1", DESIRED_HTTPS_PORT, "https");
  return { kind: "started", http, https };
});

export const startSockets = (input: StartSocketsInput): Effect.Effect<SocketProxyStartOutcome> =>
  controlSockets("start", input);

export const stopSockets = (input: StartSocketsInput): Effect.Effect<SocketProxyStartOutcome> =>
  controlSockets("stop", input);
