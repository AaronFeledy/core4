/**
 * POSIX `sudo` adapter for `PrivilegeService`.
 *
 * Every sudo child runs through `ProcessRunner` without private capture: a private capture is
 * spawned detached in a new session, where sudo's tty-scoped credential ticket is invisible.
 * Lando never writes password prompt text. Some sudoers policies (`targetpw`) ask for another
 * account's password, and only sudo knows which one.
 *
 * The transport for a run is chosen once:
 * - euid 0 runs argv directly;
 * - an explicit `SUDO_ASKPASS` program uses `sudo -A`;
 * - an interactive run with real terminals hands the terminal over, then uses plain `sudo`, so
 *   sudo can prompt in that invocation when its ticket expired or caching is disabled;
 * - anything else uses `sudo -n` after the non-mutating `sudo -n -v` check.
 *
 * Interactive sudo children run uninterruptibly: Ctrl-C reaches sudo from the terminal itself,
 * and sudo has to restore terminal echo before it exits. The caller's interruption is honored
 * as soon as sudo returns, and a sudo child that ended by SIGINT ends the effect as interrupted.
 */
import { accessSync, constants, statSync } from "node:fs";
import { basename } from "node:path";

import {
  PrivilegeAuthorizationFailedError,
  PrivilegeCredentialsRequiredError,
  type PrivilegeError,
  PrivilegeUnavailableError,
  type ProcessExecError,
  type ProcessTimeoutError,
} from "@lando/sdk/errors";
import { MessageInfoEvent } from "@lando/sdk/events";
import {
  EventService,
  InteractionService,
  PrivilegeService,
  type ProcessResult,
  ProcessRunner,
  type ProcessSpawnOptions,
} from "@lando/sdk/services";
import { type Context, DateTime, Effect, Layer, Option } from "effect";

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
  /** Hands the terminal to an external prompt; the CLI retires its live progress display. */
  readonly prepareTerminal?: Effect.Effect<void>;
  /** Real terminals on stdin and stderr. Without it Lando never prompts for a password. */
  readonly hasTerminal?: () => boolean;
  readonly host?: ElevationHost;
}

export const PRIVILEGE_CREDENTIALS_REMEDIATION =
  "Run `sudo -v` in this terminal and rerun within sudo's credential timeout, or set `SUDO_ASKPASS` to an askpass program. In a terminal, rerun without `--no-interactive` and sudo asks for your password itself.";

const unavailable = (purpose: string, reason: "windows" | "no-sudo", cause?: unknown) =>
  new PrivilegeUnavailableError({
    purpose,
    message:
      reason === "windows"
        ? `Lando cannot request administrator access on Windows to ${purpose}.`
        : `Lando needs administrator access to ${purpose}, but sudo could not run.`,
    remediation:
      reason === "windows"
        ? "Run this step from an elevated (Administrator) terminal."
        : "Install sudo and allow your user to use it, or run this step as root.",
    ...(cause === undefined ? {} : { cause }),
  });

const authorizationFailed = (purpose: string, exitCode: number) =>
  new PrivilegeAuthorizationFailedError({
    purpose,
    exitCode,
    message: `sudo did not grant administrator access to ${purpose}.`,
    remediation:
      "Read sudo's message above, check that your user may use sudo (or that `SUDO_ASKPASS` prints the right password), then rerun.",
  });

const SIGINT_EXIT_CODE = 130;

// No sudo run sets a timeout, so the runner cannot report one.
const impossibleTimeout = (error: ProcessTimeoutError) => Effect.die(error);

export const makePrivilegeService = (
  runner: Context.Service.Shape<typeof ProcessRunner>,
  options: PrivilegeLayerOptions = {},
): Context.Service.Shape<typeof PrivilegeService> => {
  const host = options.host ?? { ...systemElevationHost, hasTerminal: options.hasTerminal ?? (() => false) };
  const prepareTerminal = options.prepareTerminal ?? Effect.void;

  const run = (purpose: string, spawn: ProcessSpawnOptions) =>
    runner.run(spawn).pipe(
      Effect.catchTags({
        ProcessExecError: (error: ProcessExecError) => Effect.fail(unavailable(purpose, "no-sudo", error)),
        ProcessTimeoutError: impossibleTimeout,
      }),
    );

  /**
   * sudo owns the terminal while it runs: Ctrl-C reaches it directly and it restores echo. The
   * terminal sends Lando the same SIGINT, but its handler can run after sudo's exit is observed,
   * so a child that ended by SIGINT (exit 130) is an interruption here, never a sudo refusal or a
   * failed host change.
   */
  const runOnTerminal = (purpose: string, spawn: ProcessSpawnOptions) =>
    Effect.uninterruptibleMask((restore) =>
      run(purpose, spawn).pipe(
        Effect.tap(() => restore(Effect.yieldNow)),
        Effect.tap((result) => (result.exitCode === SIGINT_EXIT_CODE ? Effect.interrupt : Effect.void)),
      ),
    );

  const canPrompt = Effect.gen(function* () {
    const interaction = yield* Effect.serviceOption(InteractionService);
    if (Option.isNone(interaction)) return false;
    return (yield* interaction.value.isInteractive) && host.hasTerminal();
  });

  const announce = Effect.fnUntraced(function* (purpose: string) {
    const events = yield* Effect.serviceOption(EventService);
    if (Option.isNone(events)) return;
    yield* events.value
      .publish(
        MessageInfoEvent.make({
          body: `Lando needs administrator access to ${purpose}. sudo asks for your password next.`,
          timestamp: yield* DateTime.now,
        }),
      )
      .pipe(Effect.catchCause(() => Effect.void));
  });

  const credentialsCached = (sudo: string, purpose: string) =>
    run(purpose, { cmd: sudo, args: ["-n", "-v"] }).pipe(Effect.map((result) => result.exitCode === 0));

  const ensureCredentials = Effect.fn("PrivilegeService.ensureCredentials")(function* (
    purpose: string,
  ): Effect.fn.Return<void, PrivilegeError> {
    const transport = elevationTransport(host);
    switch (transport._tag) {
      case "direct":
        return;
      case "unavailable":
        return yield* Effect.fail(unavailable(purpose, transport.reason));
      case "askpass": {
        const result = yield* run(purpose, {
          cmd: transport.sudo,
          args: ["-A", "-v"],
          env: { SUDO_ASKPASS: transport.askpass },
        });
        if (result.exitCode !== 0) return yield* Effect.fail(authorizationFailed(purpose, result.exitCode));
        return;
      }
      case "sudo": {
        const cached = yield* credentialsCached(transport.sudo, purpose);
        if (!(yield* canPrompt)) {
          if (cached) return;
          return yield* Effect.fail(
            new PrivilegeCredentialsRequiredError({
              purpose,
              message: `Lando needs administrator access to ${purpose}, and this run cannot ask for a password.`,
              remediation: PRIVILEGE_CREDENTIALS_REMEDIATION,
            }),
          );
        }
        // Later elevated commands in this run use plain sudo, which may prompt, so hand the
        // terminal over even when the ticket is still valid.
        if (!cached) yield* announce(purpose);
        yield* prepareTerminal;
        if (cached) return;
        const result = yield* runOnTerminal(purpose, {
          cmd: transport.sudo,
          args: ["-v"],
          inheritStdin: true,
          inheritOutput: true,
        });
        if (result.exitCode !== 0) return yield* Effect.fail(authorizationFailed(purpose, result.exitCode));
        return;
      }
      default: {
        const exhaustive: never = transport;
        return exhaustive;
      }
    }
  });

  const elevate = Effect.fn("PrivilegeService.elevate")(function* (
    command: ReadonlyArray<string>,
  ): Effect.fn.Return<ProcessResult, PrivilegeError> {
    const [cmd = "", ...args] = command;
    const purpose = `run ${basename(command[0] ?? "a command")}`;
    const transport = elevationTransport(host);
    switch (transport._tag) {
      case "direct":
        // As root the argv is the command itself, so a spawn failure is that command's failure.
        return yield* runner.run({ cmd, args }).pipe(
          Effect.catchTags({
            ProcessExecError: (error: ProcessExecError) =>
              Effect.succeed({ exitCode: 127, stdout: "", stderr: error.message }),
            ProcessTimeoutError: impossibleTimeout,
          }),
        );
      case "unavailable":
        return yield* Effect.fail(unavailable(purpose, transport.reason));
      case "askpass":
        return yield* run(purpose, {
          cmd: transport.sudo,
          args: ["-A", "--", ...command],
          env: { SUDO_ASKPASS: transport.askpass },
        });
      case "sudo": {
        if (yield* canPrompt) {
          yield* prepareTerminal;
          return yield* runOnTerminal(purpose, { cmd: transport.sudo, args: ["--", ...command] });
        }
        yield* ensureCredentials(purpose);
        return yield* run(purpose, { cmd: transport.sudo, args: ["-n", "--", ...command] });
      }
      default: {
        const exhaustive: never = transport;
        return exhaustive;
      }
    }
  });

  return PrivilegeService.of({ ensureCredentials, elevate });
};

export const layer = (options: PrivilegeLayerOptions = {}) =>
  Layer.effect(
    PrivilegeService,
    Effect.gen(function* () {
      return makePrivilegeService(yield* ProcessRunner, options);
    }),
  );
