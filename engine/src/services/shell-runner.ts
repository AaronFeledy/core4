/**
 * Bun 1.4 `Bun.Terminal` was evaluated as a PTY backend for `ShellRunner` /
 * host-shell and rejected: there is no existing PTY/ConPTY path behind these
 * services (`exec` uses embedded `bun exec`; interactive uses `Bun.spawn` + IPC `--eval`),
 * and a Terminal-backed PTY would dual-path the OpenTUI renderer terminal
 * (dynamic `import("@opentui/core")` only). Do not add `@opentui/core` here
 * or use `Bun.Terminal` in compiled cold-start files.
 */
import { resolve } from "node:path";
import { Context, Effect, Layer, Option } from "effect";

import { FileIoError, ProcessExecError, ShellExecError } from "@lando/sdk/errors";
import {
  EventService,
  type LandoEvent,
  type ProcessResult,
  ProcessRunner,
  type ShellCommandOptions,
  type ShellReplIO,
  ShellRunner,
} from "@lando/sdk/services";

import { RedactionService } from "@lando/redaction/service";
import { identityRedactor, mapFailures } from "@lando/sdk/command-result";
import { REDACTED, type Redactor, isSecretFieldName } from "@lando/sdk/secrets";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { StreamFrameSink } from "../operations/stream-frame-sink.ts";
import { bunShellDialectIssues, bunShellScriptIssue, describeBunShellIssue } from "./bun-shell-dialect.ts";
import {
  type CapturedHostExecutionContext,
  captureScopedHostExecutionContext,
} from "./host-execution-context.ts";
import { runHostShellRepl } from "./host-shell-repl.ts";
import { type RunnerRedactionCarrier, runnerEnvRedaction } from "./runner-redaction.ts";
import { quoteShellPath } from "./shell-quote.ts";
import { streamBunCommand, streamBunScript } from "./shell-script-stream.ts";
import { environmentForRedaction } from "./tooling-input-environment.ts";

export type ShellRedactionCarrier = RunnerRedactionCarrier;

export const ShellRedactionTokens = Context.Reference<ShellRedactionCarrier>(
  "@lando/engine/ShellRedactionTokens",
  {
    defaultValue: (): ShellRedactionCarrier => ({ substring: [] }),
  },
);

const shellError = (
  command: string,
  options: ShellCommandOptions | undefined,
  cause: unknown,
  output?: ProcessResult,
): ShellExecError =>
  new ShellExecError({
    message: cause instanceof Error ? cause.message : `Shell command failed: ${command}`,
    command,
    ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(output?.exitCode === undefined ? {} : { exitCode: output.exitCode }),
    ...(output?.stdout === undefined ? {} : { stdout: output.stdout }),
    ...(output?.stderr === undefined ? {} : { stderr: output.stderr }),
    ...(options?.capture === true ? {} : { cause }),
    remediation:
      cause instanceof FileIoError || cause instanceof ProcessExecError
        ? cause.remediation
        : "Fix the Bun Shell command so it succeeds in the reported working directory, then re-run.",
  });

const redactorForOptions = Effect.fnUntraced(function* (context: CapturedHostExecutionContext) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None") return identityRedactor;
  const carrier = yield* ShellRedactionTokens;
  const tiers = yield* runnerEnvRedaction(carrier, context);
  return yield* redaction.value.forProfile("secrets", {
    redactionTokens: [...carrier.substring, ...tiers.substring],
    wholeTokenValues: tiers.wholeToken,
  });
});

export const withShellRedactionTokens = <A, E, R>(
  redactionTokens: ShellRedactionCarrier,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => effect.pipe(Effect.provideService(ShellRedactionTokens, redactionTokens));

const publishShellEvent = (event: LandoEvent): Effect.Effect<void> =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event).pipe(Effect.ignore) : Effect.void,
    ),
  );

type ShellEvent = ReturnType<typeof shellEventShape> &
  Partial<ProcessResult> & {
    readonly _tag: "pre-shell-exec" | "post-shell-exec";
  };

const publishRedactedShellEvent = Effect.fnUntraced(function* (redactor: Redactor, event: ShellEvent) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None") return;
  const secretEnv = yield* environmentForRedaction({}, event.env);
  yield* publishShellEvent({
    ...event,
    command: redactor.redactString(event.command),
    ...(event.cwd === undefined ? {} : { cwd: redactor.redactString(event.cwd) }),
    ...(event.env === undefined
      ? {}
      : {
          env: Object.fromEntries(
            Object.entries(event.env).map(([key, value]) => [
              key,
              isSecretFieldName(key) && Object.hasOwn(secretEnv, key)
                ? REDACTED
                : redactor.redactString(value),
            ]),
          ),
        }),
    ...(event.stdout === undefined ? {} : { stdout: redactor.redactString(event.stdout) }),
    ...(event.stderr === undefined ? {} : { stderr: redactor.redactString(event.stderr) }),
  });
});

const shellEventShape = (command: string, options: ShellCommandOptions | undefined) => ({
  command,
  ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options?.env === undefined ? {} : { env: { ...options.env } }),
});

const redactShellError = (redactor: Redactor, error: ShellExecError, capture: boolean) =>
  Effect.sync(
    () =>
      new ShellExecError({
        message: redactor.redactString(error.message),
        command: redactor.redactString(error.command),
        ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
        ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
        ...(error.stdout === undefined ? {} : { stdout: redactor.redactString(error.stdout) }),
        ...(error.stderr === undefined ? {} : { stderr: redactor.redactString(error.stderr) }),
        ...(capture ? {} : { cause: redactor.redactValue(error.cause) }),
        remediation: redactor.redactString(error.remediation),
      }),
  );

/** `Column N: <problem>` for a command or `path:line:col: <problem>` for a script, with its fix. */
interface DialectRejection {
  readonly message: string;
  readonly remediation: string;
}

const commandRejection = (command: string): Effect.Effect<DialectRejection | undefined> =>
  Effect.sync(() => {
    const issue = bunShellDialectIssues(command)[0];
    return issue === undefined
      ? undefined
      : { message: describeBunShellIssue(issue), remediation: issue.suggestion };
  });

// Bun runs a `.sh` file with its shell and anything else as JavaScript or TypeScript.
const scriptRejection = (path: string): Effect.Effect<DialectRejection | undefined> =>
  path.endsWith(".sh")
    ? Effect.promise(() => Bun.file(path).text()).pipe(
        Effect.map((source) => {
          const issue = bunShellScriptIssue(source);
          return issue === undefined
            ? undefined
            : {
                message: `${path}:${issue.line}:${issue.column}: ${issue.message}`,
                remediation: issue.suggestion,
              };
        }),
        // An unreadable script fails when Bun starts it, with Bun's own error; there's nothing to scan.
        Effect.catchCause(() => Effect.succeed(undefined)),
      )
    : Effect.succeed(undefined);

const execWithEvents = Effect.fn("ShellRunner.exec")(function* <Options extends ShellCommandOptions>(
  command: string,
  options: Options | undefined,
  execute: (
    options: Options | undefined,
    context: CapturedHostExecutionContext,
  ) => Effect.Effect<ProcessResult, ShellExecError>,
  rejection: Effect.Effect<DialectRejection | undefined>,
) {
  const snapshot =
    options === undefined
      ? undefined
      : {
          ...options,
          ...(options.env === undefined ? {} : { env: { ...options.env } }),
          ...(options.argv === undefined ? {} : { argv: [...options.argv] }),
        };
  const context = yield* captureScopedHostExecutionContext({
    ...snapshot,
    env: { ...snapshot?.env, BUN_BE_BUN: "1" },
  });
  const redactor = yield* redactorForOptions(context);
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "Some") {
    const carrier = yield* ShellRedactionTokens;
    const tiers = yield* runnerEnvRedaction(carrier, context);
    yield* redaction.value.registerValues([...carrier.substring, ...tiers.substring]);
    yield* redaction.value.registerValues(tiers.wholeToken, { match: "whole-token" });
  }
  // Text Bun Shell would misread or reject never starts, so a command can't half-run on a parse gap.
  const rejected = yield* rejection;
  if (rejected !== undefined)
    return yield* redactShellError(
      redactor,
      new ShellExecError({
        ...rejected,
        command,
        ...(snapshot?.cwd === undefined ? {} : { cwd: snapshot.cwd }),
      }),
      snapshot?.capture === true,
    ).pipe(Effect.flatMap(Effect.fail));
  if (snapshot?.capture !== true)
    yield* publishRedactedShellEvent(redactor, {
      _tag: "pre-shell-exec",
      ...shellEventShape(command, snapshot),
    });
  const result = yield* execute(snapshot, context).pipe(
    Effect.catch((error) =>
      Effect.flatMap(redactShellError(redactor, error, snapshot?.capture === true), Effect.fail),
    ),
  );
  if (snapshot?.capture !== true)
    yield* publishRedactedShellEvent(redactor, {
      _tag: "post-shell-exec",
      ...shellEventShape(command, snapshot),
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    });
  return result;
});

export const makeShellRunnerService = (
  makeReplIO: () => ShellReplIO,
  privateFileAccess: PrivateFileAccess,
  runner: import("@lando/sdk/services").ProcessRunner["Service"],
): Context.Service.Shape<typeof ShellRunner> => {
  const service: Context.Service.Shape<typeof ShellRunner> = ShellRunner.of({
    exec: (command, options) =>
      execWithEvents(
        command,
        options,
        (snapshot, context) =>
          Effect.gen(function* () {
            const sink =
              snapshot?.capture === true
                ? Option.none<StreamFrameSink["Service"]>()
                : yield* Effect.serviceOption(StreamFrameSink);
            const redaction = yield* ShellRedactionTokens;
            const result = yield* streamBunCommand(command, snapshot, { sink, context, redaction }).pipe(
              Effect.provideService(ProcessRunner, runner),
              mapFailures((cause) => shellError(command, snapshot, cause)),
            );
            return yield* result.exitCode === 0
              ? Effect.succeed(result)
              : Effect.fail(
                  shellError(
                    command,
                    snapshot,
                    new Error(`Shell command exited with code ${result.exitCode}`),
                    result,
                  ),
                );
          }),
        commandRejection(command),
      ),
    run: (command, options) => service.exec(command, options),
    runScript: Effect.fn("ShellRunner.runScript")(function* (path, options) {
      const command = `bun ${quoteShellPath(path)}`;
      return yield* execWithEvents(
        command,
        options,
        (snapshot, context) =>
          Effect.gen(function* () {
            const sink =
              snapshot?.capture === true
                ? Option.none<StreamFrameSink["Service"]>()
                : yield* Effect.serviceOption(StreamFrameSink);
            const redaction = yield* ShellRedactionTokens;
            return yield* streamBunScript(path, snapshot, {
              sink: Option.getOrUndefined(sink),
              context,
              redaction,
            }).pipe(
              Effect.provideService(ProcessRunner, runner),
              mapFailures((cause) => shellError(command, snapshot, cause)),
              Effect.flatMap((result) =>
                result.exitCode === 0
                  ? Effect.succeed(result)
                  : Effect.fail(
                      shellError(
                        command,
                        snapshot,
                        new Error(`Shell command exited with code ${result.exitCode}`),
                        result,
                      ),
                    ),
              ),
            );
          }),
        scriptRejection(resolve(options?.cwd ?? ".", path)),
      );
    }),
    interactive: (spec) => runHostShellRepl({ ...spec, io: spec.io ?? makeReplIO() }, privateFileAccess),
  });
  return service;
};

export const layer = (makeReplIO: () => ShellReplIO): Layer.Layer<ShellRunner, never, ProcessRunner> =>
  layerWithPrivateFileAccess(makeReplIO).pipe(Layer.provide(PrivateFileAccessService.layer));

export const layerWithPrivateFileAccess = (
  makeReplIO: () => ShellReplIO,
): Layer.Layer<ShellRunner, never, PrivateFileAccessService | ProcessRunner> =>
  Layer.effect(
    ShellRunner,
    Effect.gen(function* () {
      return makeShellRunnerService(makeReplIO, yield* PrivateFileAccessService, yield* ProcessRunner);
    }),
  );
