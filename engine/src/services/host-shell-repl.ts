import { Effect, Option } from "effect";

import { FileIoError, ShellExecError } from "@lando/sdk/errors";
import { REDACTED, type Redactor } from "@lando/sdk/secrets";
import {
  EventService,
  type LandoEvent,
  type ProcessResult,
  type ShellInteractiveResult,
  type ShellInteractiveSpec,
  type ShellReplIO,
  type ShellReplInput,
} from "@lando/sdk/services";

import { RedactionService, collectSecretEnvValues, createStandaloneRedactor } from "@lando/redaction/service";
import type { PrivateFileAccess } from "@lando/state-store/private-file-access";
import { captureHostExecutionContext } from "./host-execution-context.ts";
import { DEFAULT_SHELL_HISTORY_LIMIT, appendShellHistory, readShellHistory } from "./host-shell-history.ts";
import { hostShellError, redactHostShellError, runHostShellLine } from "./host-shell-line.ts";
import { makeStatefulShellRedactor } from "./host-shell-redactor.ts";
import { resolveHostShellSecrets } from "./host-shell-secrets.ts";

const EXIT_LINE = /^exit(?:\s+([+-]?[0-9]+))?\s*$/;
type HostShellReplSpec = Omit<ShellInteractiveSpec, "io"> & { readonly io: ShellReplIO };

const nextInput = (iterator: AsyncIterator<ShellReplInput>): Promise<ShellReplInput> =>
  iterator.next().then((result) => (result.done ? { _tag: "eof" } : result.value));

const settleWithoutWaiting = (promise: PromiseLike<unknown> | undefined): void => {
  if (promise === undefined) return;
  void Promise.resolve(promise).then(
    () => undefined,
    () => undefined,
  );
};

const parseExit = (line: string, lastStatus: number): number | undefined => {
  const match = EXIT_LINE.exec(line);
  if (match === null) return undefined;
  if (match[1] === undefined) return lastStatus;
  const requested = Number.parseInt(match[1], 10);
  return ((requested % 256) + 256) % 256;
};

export const runHostShellRepl = Effect.fn("ShellRunner.interactive")(function* (
  spec: HostShellReplSpec,
  privateFileAccess: PrivateFileAccess,
): Effect.fn.Return<ShellInteractiveResult, ShellExecError> {
  const eventService = yield* Effect.serviceOption(EventService);
  const redactionService = yield* Effect.serviceOption(RedactionService);
  const sourceEnv = { ...process.env, ...spec.env };
  const redactorFor = (redactionTokens: Iterable<string>, env = sourceEnv): Effect.Effect<Redactor> => {
    const options = {
      sourceEnv: env,
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
  const io = spec.io;
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
      const historyLimit = spec.historyLimit ?? DEFAULT_SHELL_HISTORY_LIMIT;
      if (spec.historyFile !== undefined)
        await readShellHistory(spec.historyFile, historyLimit, privateFileAccess);
      let lastStatus = 0;
      let pending: Promise<ShellReplInput> | undefined;
      let abortIdle: (() => void) | undefined;
      const idleAbort = new Promise<ShellReplInput>((resolve) => {
        abortIdle = () => resolve({ _tag: "interrupt" });
      });
      const abortSession = (): void => {
        close();
        abortIdle?.();
      };
      spec.signal?.addEventListener("abort", abortSession, { once: true });
      effectSignal.addEventListener("abort", abortSession, { once: true });
      if (spec.signal?.aborted === true || effectSignal.aborted) abortSession();
      try {
        while (true) {
          pending ??= nextInput(iterator);
          const input = await Promise.race([pending, idleAbort]);
          if (input._tag === "interrupt" && (spec.signal?.aborted === true || effectSignal.aborted)) {
            return { exitCode: 130 };
          }
          pending = undefined;
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
          const captured = captureHostExecutionContext(spec);
          const lineEnv = { ...captured.env };
          const envRedactionTokens = collectSecretEnvValues(lineEnv);
          const resolution = await Effect.runPromise(
            Effect.result(
              resolveHostShellSecrets(line, (reference) =>
                spec.resolveSecret(reference).pipe(
                  Effect.tap((value) =>
                    Option.match(redactionService, {
                      onNone: () => Effect.void,
                      onSome: (service) => service.registerValues([value]),
                    }),
                  ),
                ),
              ),
            ),
          );
          if (resolution._tag === "Failure") {
            io.writeStderr(`${baseRedactor.redactString(resolution.failure.message)}\n`);
            io.prompt?.();
            continue;
          }
          const resolved = resolution.success;
          const redactor = await Effect.runPromise(redactorFor(resolved.values, lineEnv));
          const command = redactor.redactString(
            resolved.fragments.reduce(
              (text, fragment, index) => `${text}${index === 0 ? "" : REDACTED}${fragment}`,
              "",
            ),
          );
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
            await appendShellHistory(spec.historyFile, command, historyLimit, privateFileAccess);
          };
          const outputRedactor = makeStatefulShellRedactor(
            redactor,
            [...envRedactionTokens, ...resolved.values],
            (channel: "stdout" | "stderr", chunk) => {
              if (channel === "stdout") io.writeStdout(chunk);
              else io.writeStderr(chunk);
            },
          );
          let result: ProcessResult;
          try {
            const execution = runHostShellLine(
              {
                fragments: resolved.fragments,
                values: resolved.values,
                ...(spec.cwd === undefined ? {} : { cwd: spec.cwd }),
                ...(spec.env === undefined ? {} : { env: spec.env }),
                signal: controller.signal,
                writeStdout: (chunk) => outputRedactor.push("stdout", chunk),
                writeStderr: (chunk) => outputRedactor.push("stderr", chunk),
              },
              captured,
            )
              .finally(() => {
                outputRedactor.flush();
              })
              .then((lineResult) => ({
                ...lineResult,
                stdout: outputRedactor.captured("stdout"),
                stderr: outputRedactor.captured("stderr"),
              }));
            pending = nextInput(iterator);
            const raced = await Promise.race([
              execution.then((lineResult) => ({ kind: "result" as const, result: lineResult })),
              pending.then((event) => ({ kind: "input" as const, event })),
            ]);
            if (raced.kind === "input" && raced.event._tag === "interrupt") {
              controller.abort();
              result = await execution;
              pending = undefined;
            } else {
              result = raced.kind === "result" ? raced.result : await execution;
              if (raced.kind === "input") pending = Promise.resolve(raced.event);
            }
          } catch (cause) {
            if (controller.signal.aborted) return { exitCode: 130 };
            const message = redactor.redactString(
              cause instanceof Error ? cause.message : "Host shell evaluator failed.",
            );
            throw new ShellExecError({
              message,
              command,
              ...(spec.cwd === undefined ? {} : { cwd: redactor.redactString(spec.cwd) }),
              cause: redactor.redactValue(cause),
              remediation: redactor.redactString(
                cause instanceof FileIoError
                  ? cause.remediation
                  : "Fix the Bun Shell command so it succeeds in the reported working directory, then re-run.",
              ),
            });
          } finally {
            spec.signal?.removeEventListener("abort", abort);
            effectSignal.removeEventListener("abort", abort);
          }
          lastStatus = result.exitCode;
          await publishPost(result);
          await persistHistory();
          if (
            outputRedactor.needsTrailingNewline("stderr") ||
            (result.stderr.length === 0 && outputRedactor.needsTrailingNewline("stdout"))
          ) {
            io.writeStdout("\n");
          }
          if (spec.signal?.aborted === true) return { exitCode: 130 };
          io.prompt?.();
        }
      } finally {
        spec.signal?.removeEventListener("abort", abortSession);
        effectSignal.removeEventListener("abort", abortSession);
        close();
        settleWithoutWaiting(pending);
        settleWithoutWaiting(Promise.resolve().then(() => iterator.return?.()));
      }
    },
    catch: (cause) =>
      cause instanceof ShellExecError
        ? redactHostShellError(baseRedactor, cause)
        : hostShellError(
            baseRedactor.redactString(cause instanceof Error ? cause.message : "Host shell REPL failed."),
            REDACTED,
            baseRedactor.redactValue(cause),
          ),
  }).pipe(Effect.ensuring(Effect.sync(close)));
});
