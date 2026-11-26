/**
 * One run's sudo credentials. A session asks for them at most once, refreshes sudo's ticket
 * before every command and on a timer while it is open, and forgets a ticket it created when its
 * scope closes. Each command runs as `sudo -n -- argv` with piped input, so it never needs the
 * terminal; only a fresh password prompt does.
 *
 * Every sudo child runs through `ProcessRunner` without private capture: a private capture is
 * spawned detached in a new session, where sudo's tty-scoped credential ticket is invisible.
 */
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
  type PrivilegeElevateOptions,
  type PrivilegeSession,
  type ProcessResult,
  type ProcessRunner,
  type ProcessSpawnOptions,
} from "@lando/sdk/services";
import { type Context, DateTime, Duration, Effect, Option, Scope } from "effect";

/** How the CLI lends its terminal to sudo's own password prompt. */
export interface PrivilegeHandoff {
  /**
   * Runs `body` while it owns the terminal: Lando's output shows everything published before
   * the call, and Lando draws nothing until `body` ends.
   */
  readonly suspend: <A, E, R>(body: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export const identityHandoff: PrivilegeHandoff = { suspend: (body) => body };

export interface SudoSessionContext {
  readonly runner: Context.Service.Shape<typeof ProcessRunner>;
  readonly handoff: PrivilegeHandoff;
  /** Real terminals on stdin and stderr, which a sudo prompt needs. */
  readonly hasTerminal: () => boolean;
  readonly keepAliveInterval: Duration.Duration;
}

export const PRIVILEGE_CREDENTIALS_REMEDIATION =
  "Run `sudo -v` in this terminal and rerun within sudo's credential timeout, or set `SUDO_ASKPASS` to an askpass program. In a terminal, rerun without `--no-interactive` and sudo asks for your password itself.";

const KEEP_ALIVE_TIMEOUT_MS = 15_000;
const SIGINT_EXIT_CODE = 130;

export const privilegeUnavailable = (purpose: string, reason: "windows" | "no-sudo", cause?: unknown) =>
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

const credentialsRequired = (purpose: string, lost: boolean) =>
  new PrivilegeCredentialsRequiredError({
    purpose,
    message: lost
      ? `Lando lost its sudo credentials while it was working to ${purpose}, and this run cannot ask for a password again.`
      : `Lando needs administrator access to ${purpose}, and this run cannot ask for a password.`,
    remediation: PRIVILEGE_CREDENTIALS_REMEDIATION,
  });

// No sudo run except the keep-alive sets a timeout, so the runner cannot report one.
const impossibleTimeout = (error: ProcessTimeoutError) => Effect.die(error);

const runSudo = (context: SudoSessionContext, purpose: string, spawn: ProcessSpawnOptions) =>
  context.runner.run(spawn).pipe(
    Effect.catchTags({
      ProcessExecError: (error: ProcessExecError) =>
        Effect.fail(privilegeUnavailable(purpose, "no-sudo", error)),
      ProcessTimeoutError: impossibleTimeout,
    }),
  );

/** `sudo -n -v` refreshes a valid ticket and fails without prompting when there is none. */
export const refreshTicket = (context: SudoSessionContext, sudo: string, purpose: string) =>
  runSudo(context, purpose, { cmd: sudo, args: ["-n", "-v"] }).pipe(
    Effect.map(({ exitCode }) => exitCode === 0),
  );

export const canPrompt = Effect.fnUntraced(function* (context: SudoSessionContext) {
  const interaction = yield* Effect.serviceOption(InteractionService);
  if (Option.isNone(interaction)) return false;
  return (yield* interaction.value.isInteractive) && context.hasTerminal();
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
    .pipe(Effect.ignore);
});

/**
 * sudo owns the terminal while it runs: Ctrl-C reaches it directly and it restores echo. The
 * terminal sends Lando the same SIGINT, but its handler can run after sudo's exit is observed,
 * so a child that ended by SIGINT (exit 130) is an interruption here, never a sudo refusal or a
 * failed command.
 */
const runOnTerminal = (context: SudoSessionContext, purpose: string, spawn: ProcessSpawnOptions) =>
  context.handoff.suspend(
    Effect.uninterruptibleMask((restore) =>
      runSudo(context, purpose, spawn).pipe(
        Effect.tap(() => restore(Effect.yieldNow)),
        Effect.tap((result) => (result.exitCode === SIGINT_EXIT_CODE ? Effect.interrupt : Effect.void)),
      ),
    ),
  );

/** Announce first, so the line is on screen before sudo writes its own prompt. */
const promptForTicket = Effect.fnUntraced(function* (
  context: SudoSessionContext,
  sudo: string,
  purpose: string,
) {
  yield* announce(purpose);
  const result = yield* runOnTerminal(context, purpose, {
    cmd: sudo,
    args: ["-v"],
    inheritStdin: true,
    inheritOutput: true,
  });
  if (result.exitCode !== 0) return yield* Effect.fail(authorizationFailed(purpose, result.exitCode));
});

/**
 * Keeps the ticket from expiring during long work between commands (a runtime download). It
 * reaches no verdict, so it is a lifecycle loop rather than a probe; the first failed refresh
 * ends it, and the next command checks the ticket itself.
 */
const keepTicketFresh = Effect.fnUntraced(function* (context: SudoSessionContext, sudo: string) {
  while (true) {
    yield* Effect.sleep(context.keepAliveInterval);
    const fresh = yield* context.runner
      .run({ cmd: sudo, args: ["-n", "-v"], timeoutMs: KEEP_ALIVE_TIMEOUT_MS })
      .pipe(
        Effect.map(({ exitCode }) => exitCode === 0),
        Effect.catch(() => Effect.succeed(false)),
      );
    if (!fresh) return;
  }
});

const forgetTicket = (context: SudoSessionContext, sudo: string) =>
  context.runner.run({ cmd: sudo, args: ["-k"] }).pipe(Effect.ignore);

export const commandPurpose = (command: ReadonlyArray<string>) =>
  `run ${basename(command[0] ?? "a command")}`;

const uncachedSession = (context: SudoSessionContext, sudo: string): PrivilegeSession => ({
  transport: "uncached",
  elevate: Effect.fnUntraced(function* (
    command: ReadonlyArray<string>,
    options?: PrivilegeElevateOptions,
  ): Effect.fn.Return<ProcessResult, PrivilegeError> {
    const purpose = commandPurpose(command);
    if (options?.stdin !== undefined) {
      return yield* Effect.fail(
        new PrivilegeUnavailableError({
          purpose,
          message: `sudo keeps no credentials between commands here, so Lando cannot pipe input to ${basename(command[0] ?? "the command")} through sudo.`,
          remediation:
            "Set `SUDO_ASKPASS` to an askpass program, or allow sudo to cache credentials (a nonzero `timestamp_timeout`), then rerun.",
        }),
      );
    }
    yield* announce(purpose);
    return yield* runOnTerminal(context, purpose, { cmd: sudo, args: ["--", ...command] });
  }),
});

const ticketSession = Effect.fnUntraced(function* (
  context: SudoSessionContext,
  sudo: string,
  transport: "cached" | "prompted",
  purpose: string,
): Effect.fn.Return<PrivilegeSession, never, Scope.Scope> {
  const scope = yield* Effect.scope;
  let keepingAlive = false;
  let forgetsTicket = transport === "prompted";
  const startKeepAlive = Effect.suspend(() => {
    if (keepingAlive) return Effect.void;
    keepingAlive = true;
    const loop = keepTicketFresh(context, sudo).pipe(
      Effect.ensuring(
        Effect.sync(() => {
          keepingAlive = false;
        }),
      ),
    );
    return Effect.asVoid(Effect.forkIn(loop, scope));
  });
  yield* startKeepAlive;
  const elevate = Effect.fnUntraced(function* (
    command: ReadonlyArray<string>,
    options?: PrivilegeElevateOptions,
  ): Effect.fn.Return<ProcessResult, PrivilegeError> {
    if (!(yield* refreshTicket(context, sudo, purpose))) {
      if (!(yield* canPrompt(context))) return yield* Effect.fail(credentialsRequired(purpose, true));
      // The ticket the prompt makes is Lando's, even if the session started from the user's own.
      // Forgetting it is registered before the prompt, so no interrupt after it can leak the ticket.
      if (!forgetsTicket) {
        forgetsTicket = true;
        yield* Scope.addFinalizer(scope, forgetTicket(context, sudo));
      }
      yield* promptForTicket(context, sudo, purpose);
      yield* startKeepAlive;
    }
    return yield* runSudo(context, purpose, {
      cmd: sudo,
      args: ["-n", "--", ...command],
      ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
    });
  });
  return { transport, elevate };
});

/** The `sudo` transport: reuse a ticket, ask once on the terminal, or fail before any command. */
export const openSudoSession = Effect.fnUntraced(function* (
  context: SudoSessionContext,
  sudo: string,
  purpose: string,
): Effect.fn.Return<PrivilegeSession, PrivilegeError, Scope.Scope> {
  if (yield* refreshTicket(context, sudo, purpose))
    return yield* ticketSession(context, sudo, "cached", purpose);
  if (!(yield* canPrompt(context))) return yield* Effect.fail(credentialsRequired(purpose, false));
  // `sudo -n -v` just found no ticket, so forgetting one is harmless if the prompt makes none; it is
  // registered first so an interrupt right after the prompt cannot leak the ticket it made.
  yield* Effect.addFinalizer(() => forgetTicket(context, sudo));
  yield* promptForTicket(context, sudo, purpose);
  if (yield* refreshTicket(context, sudo, purpose))
    return yield* ticketSession(context, sudo, "prompted", purpose);
  return uncachedSession(context, sudo);
});

/**
 * `SUDO_ASKPASS` supplies the password, so a session never needs the terminal. A ticket the user
 * already had (their own `sudo -v`) is theirs: the session uses it and leaves it. Once askpass
 * has to authorize, at open or because that ticket expired, the ticket sudo keeps is Lando's,
 * and closing the session forgets it.
 */
export const openAskpassSession = Effect.fnUntraced(function* (
  context: SudoSessionContext,
  transport: { readonly sudo: string; readonly askpass: string },
  purpose: string,
): Effect.fn.Return<PrivilegeSession, PrivilegeError, Scope.Scope> {
  const env = { SUDO_ASKPASS: transport.askpass };
  const scope = yield* Effect.scope;
  let forgetsTicket = false;
  const ownTicket = Effect.suspend(() => {
    if (forgetsTicket) return Effect.void;
    forgetsTicket = true;
    return Scope.addFinalizer(scope, forgetTicket(context, transport.sudo));
  });
  if (!(yield* refreshTicket(context, transport.sudo, purpose))) {
    // Registered before askpass runs, so an interrupt after it cannot leak the ticket it made.
    yield* ownTicket;
    const result = yield* runSudo(context, purpose, { cmd: transport.sudo, args: ["-A", "-v"], env });
    if (result.exitCode !== 0) return yield* Effect.fail(authorizationFailed(purpose, result.exitCode));
  }
  return {
    transport: "askpass",
    elevate: Effect.fnUntraced(function* (command, options) {
      const commandFor = commandPurpose(command);
      // Without a ticket, this command's askpass authorization leaves one that is Lando's.
      if (!forgetsTicket && !(yield* refreshTicket(context, transport.sudo, commandFor))) yield* ownTicket;
      return yield* runSudo(context, commandFor, {
        cmd: transport.sudo,
        args: ["-A", "--", ...command],
        env,
        ...(options?.stdin === undefined ? {} : { stdin: options.stdin }),
      });
    }),
  };
});

/** As root the argv is the command itself, so a spawn failure is that command's failure. */
export const directSession = (context: SudoSessionContext): PrivilegeSession => ({
  transport: "direct",
  elevate: ([cmd = "", ...args], options) =>
    context.runner.run({ cmd, args, ...(options?.stdin === undefined ? {} : { stdin: options.stdin }) }).pipe(
      Effect.catchTags({
        ProcessExecError: (error: ProcessExecError) =>
          Effect.succeed({ exitCode: 127, stdout: "", stderr: error.message }),
        ProcessTimeoutError: impossibleTimeout,
      }),
    ),
});

export const DEFAULT_KEEP_ALIVE_INTERVAL = Duration.seconds(60);
