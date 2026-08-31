import { type Context, Effect } from "effect";

import type { PrivilegeService, ProcessResult, ProcessRunner } from "@lando/sdk/services";

import {
  DESIRED_HTTPS_PORT,
  DESIRED_HTTP_PORT,
  type ForwardOutcome,
  probeForward,
} from "./port-acquisition.ts";
import { TRAEFIK_HTTPS_PORT, TRAEFIK_HTTP_PORT } from "./ports.ts";
import { ProxydBinaryNotFound } from "./socket-proxy-errors.ts";
import {
  POLKIT_RULE_PATH,
  PROXYD_CANDIDATES,
  SOCKET_UNIT_PATHS,
  type SocketProxyServiceType,
  UNIT_MARKER,
  buildInstallScript,
  renderPolkitRule,
} from "./socket-proxy-units.ts";

export { POLKIT_RULE_PATH, PROXYD_CANDIDATES, SOCKET_UNIT_PATHS, renderPolkitRule };
export { ProxydBinaryNotFound } from "./socket-proxy-errors.ts";

const failedResult = (exitCode = 1, stderr = ""): ProcessResult => ({ exitCode, stdout: "", stderr });

export interface HostPathAccess {
  readonly exists: (path: string) => Effect.Effect<boolean>;
  readonly readText: (path: string) => Effect.Effect<string, unknown>;
}

export interface DiscoverProxydInput {
  readonly exists: HostPathAccess["exists"];
  readonly processRunner: Context.Tag.Service<typeof ProcessRunner>;
}

export type SocketProxyInstallOutcome =
  | { readonly kind: "installed" }
  | { readonly kind: "already-installed" }
  | { readonly kind: "elevation-refused"; readonly exitCode: number; readonly stderr: string }
  | { readonly kind: "proxyd-missing" };

export type SocketProxyStartOutcome =
  | { readonly kind: "started"; readonly http: ForwardOutcome; readonly https: ForwardOutcome }
  | { readonly kind: "failed"; readonly exitCode: number; readonly stderr: string };

export interface InstallSocketProxyInput extends HostPathAccess {
  readonly user: string;
  readonly processRunner: Context.Tag.Service<typeof ProcessRunner>;
  readonly privilege: Context.Tag.Service<typeof PrivilegeService>;
  readonly serviceType?: SocketProxyServiceType;
  readonly httpTarget?: number;
  readonly httpsTarget?: number;
}

export interface StartSocketsInput {
  readonly processRunner: Context.Tag.Service<typeof ProcessRunner>;
  readonly privilege: Context.Tag.Service<typeof PrivilegeService>;
  readonly probeForward?: (host: string, port: number) => Effect.Effect<ForwardOutcome>;
}

const SOCKET_UNITS = ["lando-proxy-http.socket", "lando-proxy-https.socket"] as const;
const HTTP_SERVICE_PATH = "/etc/systemd/system/lando-proxy-http.service";
const HTTPS_SERVICE_PATH = "/etc/systemd/system/lando-proxy-https.service";

export const discoverProxydBinary = (
  input: DiscoverProxydInput,
): Effect.Effect<string, ProxydBinaryNotFound> =>
  Effect.gen(function* () {
    for (const candidate of PROXYD_CANDIDATES) {
      if (yield* input.exists(candidate)) return candidate;
    }
    const lookup = yield* input.processRunner
      .run({ cmd: "sh", args: ["-c", "command -v systemd-socket-proxyd"] })
      .pipe(Effect.catchAll(() => Effect.succeed(failedResult(1))));
    const found = lookup.stdout.trim();
    if (lookup.exitCode === 0 && found.length > 0) return found;
    return yield* Effect.fail(
      new ProxydBinaryNotFound({
        message: "systemd-socket-proxyd is not installed on this host.",
        remediation:
          "Install systemd (systemd-socket-proxyd) or continue with high-port Traefik authorities.",
      }),
    );
  });

export const isSocketProxyInstalled = (access: HostPathAccess): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    for (const path of SOCKET_UNIT_PATHS) {
      if (!(yield* access.exists(path))) return false;
      const text = yield* access.readText(path).pipe(Effect.catchAll(() => Effect.succeed("")));
      if (!text.includes(UNIT_MARKER)) return false;
    }
    return true;
  });

const hopsMatchTargets = (
  access: HostPathAccess,
  httpTarget: number,
  httpsTarget: number,
): Effect.Effect<boolean> =>
  Effect.gen(function* () {
    const httpUnit = yield* access
      .readText(HTTP_SERVICE_PATH)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    const httpsUnit = yield* access
      .readText(HTTPS_SERVICE_PATH)
      .pipe(Effect.catchAll(() => Effect.succeed("")));
    const hopPattern = /127\.0\.0\.1:\d+/u;
    if (!hopPattern.test(httpUnit) && !hopPattern.test(httpsUnit)) return true;
    return httpUnit.includes(`127.0.0.1:${httpTarget}`) && httpsUnit.includes(`127.0.0.1:${httpsTarget}`);
  });

export const installSocketProxy = (
  input: InstallSocketProxyInput,
): Effect.Effect<SocketProxyInstallOutcome> =>
  Effect.gen(function* () {
    const httpTarget = input.httpTarget ?? TRAEFIK_HTTP_PORT;
    const httpsTarget = input.httpsTarget ?? TRAEFIK_HTTPS_PORT;
    if (yield* isSocketProxyInstalled(input)) {
      if (yield* hopsMatchTargets(input, httpTarget, httpsTarget)) {
        return { kind: "already-installed" };
      }
    }
    const binary = yield* discoverProxydBinary(input).pipe(
      Effect.catchTag("ProxydBinaryNotFound", () => Effect.succeed(undefined)),
    );
    if (binary === undefined) return { kind: "proxyd-missing" };
    const script = buildInstallScript({
      user: input.user,
      binary,
      serviceType: input.serviceType ?? "notify",
      httpTarget,
      httpsTarget,
    });
    const elevated = yield* input.privilege.elevate(["/bin/sh", "-c", script]);
    if (elevated.exitCode !== 0) {
      return { kind: "elevation-refused", exitCode: elevated.exitCode, stderr: elevated.stderr };
    }
    return { kind: "installed" };
  });

const controlSockets = (
  verb: "start" | "stop",
  input: StartSocketsInput,
): Effect.Effect<SocketProxyStartOutcome> =>
  Effect.gen(function* () {
    const args = [verb, ...SOCKET_UNITS];
    const unelevated = yield* input.processRunner
      .run({ cmd: "systemctl", args })
      .pipe(Effect.catchAll((error) => Effect.succeed(failedResult(1, error.message))));
    const result =
      unelevated.exitCode === 0 ? unelevated : yield* input.privilege.elevate(["systemctl", ...args]);
    if (result.exitCode !== 0) {
      return { kind: "failed", exitCode: result.exitCode, stderr: result.stderr };
    }
    const probe = input.probeForward ?? probeForward;
    const http = yield* probe("127.0.0.1", DESIRED_HTTP_PORT);
    const https = yield* probe("127.0.0.1", DESIRED_HTTPS_PORT);
    return { kind: "started", http, https };
  });

export const startSockets = (input: StartSocketsInput): Effect.Effect<SocketProxyStartOutcome> =>
  controlSockets("start", input);

export const stopSockets = (input: StartSocketsInput): Effect.Effect<SocketProxyStartOutcome> =>
  controlSockets("stop", input);
