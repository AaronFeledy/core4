/**
 * Bun 1.4 `Bun.Terminal` was evaluated as a PTY backend for `ShellRunner` /
 * host-shell and rejected: there is no existing PTY/ConPTY path behind these
 * services (`exec` uses embedded `bun exec`; interactive uses `Bun.spawn` + IPC `--eval`),
 * and a Terminal-backed PTY would dual-path the OpenTUI renderer terminal
 * (dynamic `import("@opentui/core")` only). Do not add `@opentui/core` here
 * or use `Bun.Terminal` in compiled cold-start files.
 */
import { Context, Effect, Layer, Option } from "effect";

import { ShellExecError } from "@lando/sdk/errors";
import {
  EventService,
  type LandoEvent,
  type ProcessResult,
  type ShellCommandOptions,
  type ShellReplIO,
  ShellRunner,
} from "@lando/sdk/services";

import { RedactionService, collectSecretEnvValues } from "@lando/redaction/service";
import { identityRedactor } from "@lando/sdk/command-result";
import { type PrivateFileAccess, PrivateFileAccessService } from "@lando/state-store/private-file-access";
import { StreamFrameSink } from "../operations/stream-frame-sink.ts";
import { runHostShellRepl } from "./host-shell-repl.ts";
import { quoteShellPath } from "./shell-quote.ts";
import { streamBunCommand, streamBunScript } from "./shell-script-stream.ts";

const ShellRedactionTokens = Context.Reference<ReadonlyArray<string>>("@lando/engine/ShellRedactionTokens", {
  defaultValue: (): ReadonlyArray<string> => [],
});

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
    cause,
    remediation: "Fix the shell command so it succeeds in the reported working directory, then re-run.",
  });

const redactorForOptions = Effect.fnUntraced(function* (options: ShellCommandOptions | undefined) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "None") return identityRedactor;
  const redactionTokens = yield* ShellRedactionTokens;
  return yield* redaction.value.forProfile("secrets", {
    sourceEnv: { ...process.env, ...(options?.env ?? {}) },
    redactionTokens,
  });
});

export const withShellRedactionTokens = <A, E, R>(
  redactionTokens: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> => effect.pipe(Effect.provideService(ShellRedactionTokens, redactionTokens));

const publishShellEvent = (event: LandoEvent): Effect.Effect<void> =>
  Effect.serviceOption(EventService).pipe(
    Effect.flatMap((events) =>
      events._tag === "Some" ? events.value.publish(event).pipe(Effect.ignore) : Effect.void,
    ),
  );

const redactShellEvent = Effect.fnUntraced(function* (
  options: ShellCommandOptions | undefined,
  event: LandoEvent,
) {
  const redactor = yield* redactorForOptions(options);
  return redactor.redactValue(event) as LandoEvent;
});

const publishRedactedShellEvent = (options: ShellCommandOptions | undefined, event: LandoEvent) =>
  Effect.serviceOption(RedactionService).pipe(
    Effect.flatMap((redaction) => {
      if (redaction._tag === "None") return Effect.void;
      return redactShellEvent(options, event).pipe(Effect.flatMap(publishShellEvent));
    }),
  );

const shellEventShape = (command: string, options: ShellCommandOptions | undefined) => ({
  command,
  ...(options?.cwd === undefined ? {} : { cwd: options.cwd }),
  ...(options?.env === undefined ? {} : { env: { ...options.env } }),
});

const redactShellError = Effect.fnUntraced(function* (
  options: ShellCommandOptions | undefined,
  error: ShellExecError,
) {
  const redactor = yield* redactorForOptions(options);
  return new ShellExecError({
    message: redactor.redactString(error.message),
    command: redactor.redactString(error.command),
    ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.stdout === undefined ? {} : { stdout: redactor.redactString(error.stdout) }),
    ...(error.stderr === undefined ? {} : { stderr: redactor.redactString(error.stderr) }),
    cause: error.cause,
    remediation: "Fix the shell command so it succeeds in the reported working directory, then re-run.",
  });
});

const execWithEvents = Effect.fn("ShellRunner.exec")(function* (
  command: string,
  options: ShellCommandOptions | undefined,
  execute: Effect.Effect<ProcessResult, ShellExecError>,
) {
  const redaction = yield* Effect.serviceOption(RedactionService);
  if (redaction._tag === "Some") {
    yield* redaction.value.registerValues([
      ...(yield* ShellRedactionTokens),
      ...collectSecretEnvValues(options?.env),
    ]);
  }
  yield* publishRedactedShellEvent(options, {
    _tag: "pre-shell-exec",
    ...shellEventShape(command, options),
  });
  const result = yield* execute.pipe(
    Effect.catch((error) => Effect.flatMap(redactShellError(options, error), Effect.fail)),
  );
  yield* publishRedactedShellEvent(options, {
    _tag: "post-shell-exec",
    ...shellEventShape(command, options),
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
  });
  return result;
});

export const makeShellRunnerService = (
  makeReplIO: () => ShellReplIO,
  privateFileAccess: PrivateFileAccess,
): Context.Service.Shape<typeof ShellRunner> => {
  const service: Context.Service.Shape<typeof ShellRunner> = ShellRunner.of({
    exec: (command, options) =>
      execWithEvents(
        command,
        options,
        Effect.gen(function* () {
          const sink = yield* Effect.serviceOption(StreamFrameSink);
          const result = yield* streamBunCommand(command, options, sink).pipe(
            Effect.mapError((cause) => shellError(command, options, cause)),
          );
          return yield* result.exitCode === 0
            ? Effect.succeed(result)
            : Effect.fail(
                shellError(
                  command,
                  options,
                  new Error(`Shell command exited with code ${result.exitCode}`),
                  result,
                ),
              );
        }),
      ),
    run: (command, options) => service.exec(command, options),
    runScript: Effect.fn("ShellRunner.runScript")(function* (path, options) {
      const command = `bun ${quoteShellPath(path)}`;
      const sink = yield* Effect.serviceOption(StreamFrameSink);
      return yield* execWithEvents(
        command,
        options,
        streamBunScript(path, options, {
          sink: Option.getOrUndefined(sink),
        }).pipe(
          Effect.mapError((cause) => shellError(command, options, cause)),
          Effect.flatMap((result) =>
            result.exitCode === 0
              ? Effect.succeed(result)
              : Effect.fail(
                  shellError(
                    command,
                    options,
                    new Error(`Shell command exited with code ${result.exitCode}`),
                    result,
                  ),
                ),
          ),
        ),
      );
    }),
    interactive: (spec) => runHostShellRepl({ ...spec, io: spec.io ?? makeReplIO() }, privateFileAccess),
  });
  return service;
};

export const layer = (makeReplIO: () => ShellReplIO): Layer.Layer<ShellRunner> =>
  layerWithPrivateFileAccess(makeReplIO).pipe(Layer.provide(PrivateFileAccessService.layer));

export const layerWithPrivateFileAccess = (
  makeReplIO: () => ShellReplIO,
): Layer.Layer<ShellRunner, never, PrivateFileAccessService> =>
  Layer.effect(
    ShellRunner,
    Effect.map(PrivateFileAccessService, (privateFileAccess) =>
      makeShellRunnerService(makeReplIO, privateFileAccess),
    ),
  );
