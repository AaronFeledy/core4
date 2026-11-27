/**
 * POSIX `sudo` adapter for `PrivilegeService`.
 *
 * The transport for a run is chosen once:
 * - euid 0 runs argv directly;
 * - an explicit `SUDO_ASKPASS` program uses `sudo -A`;
 * - anything else uses `sudo`: a valid ticket is reused, an interactive run with real terminals
 *   lets sudo ask once on the terminal, and any other run fails before a command runs.
 *
 * Lando never writes password prompt text. Some sudoers policies (`targetpw`) ask for another
 * account's password, and only sudo knows which one. Session mechanics live in
 * `privilege-session.ts`.
 */
import { accessSync, constants, statSync } from "node:fs";

import type { PrivilegeError } from "@lando/sdk/errors";
import type { PrivilegeCredentialStatus } from "@lando/sdk/schema";
import {
  type PrivilegeElevateOptions,
  PrivilegeService,
  type ProcessResult,
  ProcessRunner,
} from "@lando/sdk/services";
import { type Context, Duration, Effect, Layer } from "effect";

import {
  DEFAULT_KEEP_ALIVE_INTERVAL,
  PRIVILEGE_CREDENTIALS_REMEDIATION,
  type PrivilegeHandoff,
  type SudoSessionContext,
  canPrompt,
  commandPurpose,
  directSession,
  identityHandoff,
  openAskpassSession,
  openSudoSession,
  privilegeUnavailable,
  refreshTicket,
} from "./privilege-session.ts";

export { PRIVILEGE_CREDENTIALS_REMEDIATION, type PrivilegeHandoff } from "./privilege-session.ts";

export type ElevationTransport =
  | { readonly _tag: "direct" }
  | { readonly _tag: "unavailable"; readonly reason: "windows" | "no-sudo" }
  | { readonly _tag: "askpass"; readonly sudo: string; readonly askpass: string }
  | { readonly _tag: "sudo"; readonly sudo: string };

/** Host facts the transport decision reads; tests inject a fake host. */
export interface ElevationHost {
  readonly platform: NodeJS.Platform;
  readonly euid: () => number | undefined;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly which: (command: string) => string | null;
  readonly isExecutableFile: (path: string) => boolean;
  /** Real terminals on stdin and stderr, which a sudo prompt needs. */
  readonly hasTerminal: () => boolean;
}

// Terminal facts belong to the CLI, which passes `hasTerminal` when it builds the layer.
export const systemElevationHost: Omit<ElevationHost, "hasTerminal"> = {
  platform: process.platform,
  euid: () => process.geteuid?.(),
  env: process.env,
  which: (command) => Bun.which(command),
  isExecutableFile: (path) => {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
};

/** Pure transport choice. Linux and macOS share the POSIX sudo path; WSL reports linux. */
export const elevationTransport = (host: ElevationHost): ElevationTransport => {
  if (host.platform === "win32") return { _tag: "unavailable", reason: "windows" };
  if (host.euid() === 0) return { _tag: "direct" };
  const sudo = host.which("sudo");
  if (sudo === null) return { _tag: "unavailable", reason: "no-sudo" };
  const askpass = host.env.SUDO_ASKPASS;
  return askpass !== undefined && askpass !== "" && host.isExecutableFile(askpass)
    ? { _tag: "askpass", sudo, askpass }
    : { _tag: "sudo", sudo };
};

export interface PrivilegeLayerOptions {
  /** Lends the terminal to sudo's prompt; the CLI pauses its progress display around it. */
  readonly handoff?: PrivilegeHandoff;
  /** Real terminals on stdin and stderr. Without it Lando never prompts for a password. */
  readonly hasTerminal?: () => boolean;
  readonly host?: ElevationHost;
  /** How often an open session refreshes sudo's ticket. */
  readonly keepAliveIntervalMs?: number;
}

export const makePrivilegeService = (
  runner: Context.Service.Shape<typeof ProcessRunner>,
  options: PrivilegeLayerOptions = {},
): Context.Service.Shape<typeof PrivilegeService> => {
  const host = options.host ?? { ...systemElevationHost, hasTerminal: options.hasTerminal ?? (() => false) };
  const context: SudoSessionContext = {
    runner,
    handoff: options.handoff ?? identityHandoff,
    hasTerminal: host.hasTerminal,
    keepAliveInterval:
      options.keepAliveIntervalMs === undefined
        ? DEFAULT_KEEP_ALIVE_INTERVAL
        : Duration.millis(options.keepAliveIntervalMs),
  };

  const credentialStatus = Effect.fn("PrivilegeService.credentialStatus")(
    function* (): Effect.fn.Return<PrivilegeCredentialStatus> {
      const transport = elevationTransport(host);
      switch (transport._tag) {
        case "direct":
          return { state: "root" };
        case "unavailable": {
          const { message, remediation } = privilegeUnavailable("make host changes", transport.reason);
          return { state: "unavailable", detail: `${message} ${remediation}` };
        }
        case "askpass":
          return { state: "askpass" };
        case "sudo": {
          const cached = yield* refreshTicket(context, transport.sudo, "check sudo credentials").pipe(
            Effect.catchTag("PrivilegeUnavailableError", () => Effect.succeed(undefined)),
          );
          if (cached === undefined) {
            const { message, remediation } = privilegeUnavailable("make host changes", "no-sudo");
            return { state: "unavailable", detail: `${message} ${remediation}` };
          }
          if (cached) return { state: "cached" };
          if (yield* canPrompt(context)) return { state: "will-prompt" };
          return { state: "required", detail: PRIVILEGE_CREDENTIALS_REMEDIATION };
        }
        default: {
          const exhaustive: never = transport;
          return exhaustive;
        }
      }
    },
  )();

  const openSession = Effect.fn("PrivilegeService.openSession")(function* (purpose: string) {
    const transport = elevationTransport(host);
    switch (transport._tag) {
      case "direct":
        return directSession(context);
      case "unavailable":
        return yield* Effect.fail(privilegeUnavailable(purpose, transport.reason));
      case "askpass":
        return yield* openAskpassSession(context, transport, purpose);
      case "sudo":
        return yield* openSudoSession(context, transport.sudo, purpose);
      default: {
        const exhaustive: never = transport;
        return exhaustive;
      }
    }
  });

  const elevate = Effect.fn("PrivilegeService.elevate")(function* (
    command: ReadonlyArray<string>,
    elevateOptions?: PrivilegeElevateOptions,
  ): Effect.fn.Return<ProcessResult, PrivilegeError> {
    return yield* Effect.scoped(
      openSession(commandPurpose(command)).pipe(
        Effect.flatMap((session) => session.elevate(command, elevateOptions)),
      ),
    );
  });

  return PrivilegeService.of({ credentialStatus, openSession, elevate });
};

export const layer = (options: PrivilegeLayerOptions = {}) =>
  Layer.effect(
    PrivilegeService,
    Effect.gen(function* () {
      return makePrivilegeService(yield* ProcessRunner, options);
    }),
  );
