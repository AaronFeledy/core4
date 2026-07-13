import { Effect, Option } from "effect";

import { ShellExecError } from "@lando/sdk/errors";
import { REDACTED, type Redactor } from "@lando/sdk/secrets";
import {
  EventService,
  type LandoEvent,
  type ProcessResult,
  type ShellInteractiveResult,
  type ShellInteractiveSpec,
  type ShellReplInput,
} from "@lando/sdk/services";

import { RedactionService, createStandaloneRedactor } from "../redaction/service.ts";
import { DEFAULT_SHELL_HISTORY_LIMIT, readShellHistory, writeShellHistory } from "./host-shell-history.ts";
import { runHostShellLine } from "./host-shell-line.ts";
import { makeProcessShellReplIO } from "./host-shell-terminal.ts";

const SECRET_REFERENCE = /\$\{secret:([A-Za-z0-9_.-]+)\}/g;
const EXIT_LINE = /^exit(?:\s+([0-9]{1,3}))?\s*$/;

const shellError = (message: string, command: string, cause?: unknown): ShellExecError =>
  new ShellExecError({ message, command, cause });

const redactShellError = (redactor: Redactor, error: ShellExecError): ShellExecError =>
  new ShellExecError({
    message: redactor.redactString(error.message),
    command: redactor.redactString(error.command),
    ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.stdout === undefined ? {} : { stdout: redactor.redactString(error.stdout) }),
    ...(error.stderr === undefined ? {} : { stderr: redactor.redactString(error.stderr) }),
    cause: redactor.redactValue(error.cause),
  });

const resolveSecrets = (
  line: string,
  resolveSecret: ShellInteractiveSpec["resolveSecret"],
): Effect.Effect<{ readonly line: string; readonly values: ReadonlyArray<string> }, ShellExecError> =>
  Effect.gen(function* () {
    SECRET_REFERENCE.lastIndex = 0;
    const matches = [...line.matchAll(SECRET_REFERENCE)];
    if (line.replace(SECRET_REFERENCE, "").includes("${secret:")) {
      return yield* Effect.fail(shellError("Malformed secret reference.", REDACTED));
    }
    if (matches.length === 0) return { line, values: [] as ReadonlyArray<string> };
    const values = yield* Effect.all(matches.map((match) => resolveSecret(match[1] ?? ""))).pipe(
      Effect.mapError((error) => shellError(error.message, REDACTED, error)),
    );
    let resolved = line;
    for (const [index, match] of matches.entries()) {
      resolved = resolved.replace(match[0], values[index] ?? "");
    }
    return { line: resolved, values };
  });

const nextInput = (iterator: AsyncIterator<ShellReplInput>): Promise<ShellReplInput> =>
  iterator.next().then((result) => (result.done ? { _tag: "eof" } : result.value));

const parseExit = (line: string, lastStatus: number): number | undefined => {
  const match = EXIT_LINE.exec(line);
  if (match === null) return undefined;
  return match[1] === undefined ? lastStatus : Number.parseInt(match[1], 10);
};

export const runHostShellRepl = (
  spec: ShellInteractiveSpec,
): Effect.Effect<ShellInteractiveResult, ShellExecError> =>
  Effect.gen(function* () {
    const eventService = yield* Effect.serviceOption(EventService);
    const redactionService = yield* Effect.serviceOption(RedactionService);
    const redactorFor = (redactionTokens: Iterable<string>): Effect.Effect<Redactor> => {
      const options = {
        sourceEnv: { ...process.env, ...spec.env },
        redactionTokens,
      };
      return Option.isNone(redactionService)
        ? Effect.succeed(createStandaloneRedactor("secrets", options))
        : redactionService.value.forProfile("secrets", options);
    };
    const baseRedactor = yield* redactorFor([]);
    const publish = (event: LandoEvent): Promise<void> =>
      Option.isNone(eventService)
        ? Promise.resolve()
        : Effect.runPromise(eventService.value.publish(event).pipe(Effect.ignore));
    const io = spec.io ?? makeProcessShellReplIO();
    let open = true;
    const close = (): void => {
      if (open) {
        open = false;
        io.close?.();
      }
    };
    return yield* Effect.tryPromise({
      try: async (effectSignal) => {
        const iterator = io.input[Symbol.asyncIterator]();
        const history = spec.historyFile === undefined ? [] : [...(await readShellHistory(spec.historyFile))];
        let lastStatus = 0;
        let pending = nextInput(iterator);
        while (true) {
          const input = await pending;
          pending = nextInput(iterator);
          if (input._tag === "eof") return { exitCode: lastStatus };
          if (input._tag === "interrupt") {
            lastStatus = 130;
            io.prompt?.();
            continue;
          }
          const line = input.line.trim();
          if (line.length === 0) continue;
          const exitCode = parseExit(line, lastStatus);
          if (exitCode !== undefined) return { exitCode };
          const resolution = await Effect.runPromise(Effect.either(resolveSecrets(line, spec.resolveSecret)));
          if (resolution._tag === "Left") {
            io.writeStderr(`${baseRedactor.redactString(resolution.left.message)}\n`);
            io.prompt?.();
            continue;
          }
          const resolved = resolution.right;
          const redactor = await Effect.runPromise(redactorFor(resolved.values));
          const command = redactor.redactString(resolved.line);
          await publish({
            _tag: "pre-shell-exec",
            command,
            ...(spec.cwd === undefined ? {} : { cwd: redactor.redactString(spec.cwd) }),
          });
          const controller = new AbortController();
          const abort = (): void => controller.abort();
          spec.signal?.addEventListener("abort", abort, { once: true });
          effectSignal.addEventListener("abort", abort, { once: true });
          if (spec.signal?.aborted === true || effectSignal.aborted) controller.abort();
          const publishPost = (result: ProcessResult): Promise<void> =>
            publish({
              _tag: "post-shell-exec",
              command,
              ...(spec.cwd === undefined ? {} : { cwd: redactor.redactString(spec.cwd) }),
              exitCode: result.exitCode,
              stdout: redactor.redactString(result.stdout),
              stderr: redactor.redactString(result.stderr),
            });
          const persistHistory = async (): Promise<void> => {
            if (spec.historyFile === undefined) return;
            history.push(command);
            await writeShellHistory(
              spec.historyFile,
              history,
              spec.historyLimit ?? DEFAULT_SHELL_HISTORY_LIMIT,
            );
          };
          let result: ProcessResult;
          try {
            const execution = runHostShellLine({
              line: resolved.line,
              ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
              ...(spec.env === undefined ? {} : { env: spec.env }),
              signal: controller.signal,
              writeStdout: (chunk) => io.writeStdout(redactor.redactString(chunk)),
              writeStderr: (chunk) => io.writeStderr(redactor.redactString(chunk)),
            });
            const raced = await Promise.race([
              execution.then((lineResult) => ({ kind: "result" as const, result: lineResult })),
              pending.then((event) => ({ kind: "input" as const, event })),
            ]);
            if (raced.kind === "input" && raced.event._tag === "interrupt") {
              controller.abort();
              result = await execution;
              pending = nextInput(iterator);
            } else {
              result = raced.kind === "result" ? raced.result : await execution;
              if (raced.kind === "input") pending = Promise.resolve(raced.event);
            }
          } catch (cause) {
            const message = redactor.redactString(
              cause instanceof Error ? cause.message : "Host shell evaluator failed.",
            );
            result = { exitCode: 1, stdout: "", stderr: message };
            await publishPost(result);
            await persistHistory();
            throw new ShellExecError({
              message,
              command,
              ...(spec.cwd === undefined ? {} : { cwd: redactor.redactString(spec.cwd) }),
              exitCode: result.exitCode,
              stdout: result.stdout,
              stderr: result.stderr,
              cause: redactor.redactValue(cause),
            });
          } finally {
            spec.signal?.removeEventListener("abort", abort);
            effectSignal.removeEventListener("abort", abort);
          }
          lastStatus = result.exitCode;
          await publishPost(result);
          await persistHistory();
          const trailingOutput = result.stderr.length > 0 ? result.stderr : result.stdout;
          if (trailingOutput.length > 0 && !trailingOutput.endsWith("\n")) io.writeStdout("\n");
          if (spec.signal?.aborted === true) return { exitCode: 130 };
          io.prompt?.();
        }
      },
      catch: (cause) =>
        cause instanceof ShellExecError
          ? redactShellError(baseRedactor, cause)
          : shellError(
              baseRedactor.redactString(cause instanceof Error ? cause.message : "Host shell REPL failed."),
              REDACTED,
              baseRedactor.redactValue(cause),
            ),
    }).pipe(Effect.ensuring(Effect.sync(close)));
  });
