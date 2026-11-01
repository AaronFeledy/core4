import { captureHostExecutionContext } from "@lando/engine/services/host-execution-context";
import { withPreparedProcess } from "@lando/engine/services/process-runner";
import { RedactionService, createStandaloneRedactor } from "@lando/redaction/service";
import { BunSelfReentryError, FileIoError, ProcessExecError, ProcessTimeoutError } from "@lando/sdk/errors";
import { isSecretEnvName } from "@lando/sdk/secrets";
import { type ProcessSpawnOptions, Renderer } from "@lando/sdk/services";
import { DateTime, Effect, Stream } from "effect";
import { ChildOutput } from "../child-output.ts";
import { finishCommandProgress } from "../command-progress.ts";
import { publishOptionalEvent } from "./optional-event-publish.ts";

export interface BunSelfRunOptions {
  readonly argv: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly execPath?: string;
  readonly callerSubsystem?: string;
  readonly verb?: string;
  readonly output?: "native" | "managed" | "quiet";
  readonly stdin?: string | Uint8Array;
  readonly signal?: AbortSignal;
}

export type BunSelfRunResult =
  | { readonly mode: "inherited" | "streamed"; readonly exitCode: number }
  | {
      readonly mode: "collected";
      readonly exitCode: number;
      readonly stdout: string;
      readonly stderr: string;
    };
export interface BunSelfXOptions extends BunSelfRunOptions {
  readonly spec: string;
}
export type BunSelfInstallOptions = Omit<BunSelfRunOptions, "argv" | "verb">;
export const BUN_SELF_REENTRY_ENV = "LANDO_DISALLOW_BUN_BE_BUN_REENTRY" as const;
export const BUN_BE_BUN_ENV = "BUN_BE_BUN" as const;

export const childEnv = (parent: NodeJS.ProcessEnv): Record<string, string> => ({
  ...Object.fromEntries(
    Object.entries(parent).filter((entry): entry is [string, string] => entry[1] !== undefined),
  ),
  [BUN_BE_BUN_ENV]: "1",
  [BUN_SELF_REENTRY_ENV]: "1",
});

export const bunSelfRun = Effect.fn("BunSelfRunner.run")(function* (inputOptions: BunSelfRunOptions) {
  const options = { ...inputOptions };
  const blocked = process.env[BUN_SELF_REENTRY_ENV];
  const argv = [...options.argv];
  const execPath = options.execPath ?? process.execPath;
  const captured = captureHostExecutionContext(options);
  const verb = options.verb ?? argv[0] ?? "run";
  const callerSubsystem = options.callerSubsystem ?? "cli:meta:bun";
  const service = yield* Effect.serviceOption(RedactionService);
  if (service._tag === "Some")
    yield* service.value.registerValues(
      Object.entries(captured.explicitEnv)
        .filter(([key]) => isSecretEnvName(key))
        .map(([, value]) => value),
    );
  const redactor =
    service._tag === "None"
      ? createStandaloneRedactor("secrets", { sourceEnv: captured.env })
      : yield* service.value.forProfile("secrets", { sourceEnv: captured.env });
  if (blocked !== undefined && blocked !== "" && blocked !== "0")
    return yield* Effect.fail(
      new BunSelfReentryError({
        message: "Recursive embedded Bun invocation detected.",
        execPath: redactor.redactString(execPath),
        verb: redactor.redactString(verb),
        callerSubsystem: redactor.redactString(callerSubsystem),
        remediation: "Do not nest `lando bun` inside an embedded Bun invocation.",
      }),
    );
  const policy = yield* ChildOutput;
  if (policy !== undefined) yield* policy.check;
  const renderer = yield* Effect.serviceOption(Renderer);
  const native = options.output === "native" && policy?.native === true;
  const streaming = !native && options.output !== "quiet" && policy?.stream !== undefined;
  const input: ProcessSpawnOptions = {
    cmd: execPath,
    args: argv,
    env: childEnv(captured.env),
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
    ...(options.output === "native" && policy?.stdin === true ? { inheritStdin: true } : {}),
    ...(native ? { inheritOutput: true } : streaming ? {} : { capture: true }),
  };
  return yield* withPreparedProcess(
    input,
    (runner, request) =>
      Effect.gen(function* () {
        const event = {
          verb: redactor.redactString(verb),
          callerSubsystem: redactor.redactString(callerSubsystem),
          argv: argv.map(redactor.redactString),
          cwd: redactor.redactString(request.cwd ?? captured.requestedCwd),
          mode: "embedded" as const,
        };
        yield* publishOptionalEvent({
          ...event,
          _tag: "pre-bun-self-exec",
          timestamp: DateTime.formatIso(yield* DateTime.now),
        });
        let observedExit: number | undefined;
        return yield* Effect.gen(function* () {
          let result: BunSelfRunResult;
          if (native) {
            yield* finishCommandProgress();
            const completed = yield* runner.run(request);
            observedExit = completed.exitCode;
            result = { mode: "inherited", exitCode: completed.exitCode };
          } else if (
            streaming &&
            policy?.stream !== undefined &&
            service._tag === "Some" &&
            renderer._tag === "Some"
          ) {
            const owner = yield* policy
              .stream()
              .pipe(
                Effect.provideService(RedactionService, service.value),
                Effect.provideService(Renderer, renderer.value),
              );
            let exitCode: number | undefined;
            yield* Stream.runForEach(runner.streamWithExit(request), (frame) =>
              Effect.gen(function* () {
                if ("exitCode" in frame) {
                  exitCode = frame.exitCode;
                  observedExit = frame.exitCode;
                  return;
                }
                yield* owner.sink.emit({ _tag: frame.kind, kind: "bytes", chunk: frame.chunk });
              }),
            ).pipe(Effect.ensuring(owner.finish()));
            if (exitCode === undefined)
              return yield* Effect.fail(
                new ProcessExecError({
                  cmd: execPath,
                  message: "The process stream ended without an observed child status.",
                  remediation: "Check the injected process runner's streamWithExit implementation.",
                }),
              );
            result = { mode: "streamed", exitCode };
          } else {
            const completed = yield* runner.run(request);
            observedExit = completed.exitCode;
            const output = {
              stdout: redactor.redactString(completed.stdout),
              stderr: redactor.redactString(completed.stderr),
            };
            if (policy !== undefined && options.output !== "quiet")
              yield* policy.append(execPath, completed, output);
            result = { mode: "collected", exitCode: completed.exitCode, ...output };
          }
          return result;
        }).pipe(
          Effect.ensuring(
            Effect.gen(function* () {
              if (observedExit === undefined) return;
              yield* publishOptionalEvent({
                ...event,
                _tag: "post-bun-self-exec",
                exitCode: observedExit,
                timestamp: DateTime.formatIso(yield* DateTime.now),
              });
            }),
          ),
        );
      }),
    { ...captured, env: input.env ?? captured.env },
  ).pipe(
    Effect.mapError((error) => {
      const fields = {
        message: redactor.redactString(error.message),
        remediation: redactor.redactString(error.remediation),
      };
      switch (error._tag) {
        case "FileIoError":
          return new FileIoError({
            ...fields,
            path: redactor.redactString(error.path),
            ...(error.cause === undefined
              ? {}
              : {
                  cause: redactor.redactValue(
                    error.cause instanceof Error
                      ? { ...error.cause, message: error.cause.message }
                      : error.cause,
                  ),
                }),
          });
        case "ProcessTimeoutError":
          return new ProcessTimeoutError({
            ...fields,
            cmd: redactor.redactString(error.cmd),
            elapsedMs: error.elapsedMs,
            ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
          });
        case "ProcessExecError":
          return new ProcessExecError({
            ...fields,
            cmd: redactor.redactString(error.cmd),
            ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
            ...(error.errno === undefined ? {} : { errno: error.errno }),
            ...(error.cause === undefined ? {} : { cause: redactor.redactValue(error.cause) }),
          });
        default:
          return error satisfies never;
      }
    }),
  );
});

export const bunSelfX = (options: BunSelfXOptions) =>
  bunSelfRun({ ...options, argv: ["x", options.spec, ...options.argv] });
export const bunSelfInstall = (options: BunSelfInstallOptions = {}) =>
  bunSelfRun({ ...options, argv: ["install"], verb: "install" });
