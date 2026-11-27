import { Effect, Schema } from "effect";
import type { ScenarioRunResult, ScenarioTranscriptFrame } from "./scenario-context";

const outputLimit = 8 * 1024 * 1024;
const timeoutMs = 20_000;

export class ScenarioProcessError extends Schema.TaggedError<ScenarioProcessError>()("ScenarioProcessError", {
  reason: Schema.Literals([
    "missing-binary",
    "spawn-failed",
    "input-closed",
    "line-timeout",
    "exited-before-match",
    "exit-timeout",
    "output-limit",
    "output-failed",
  ]),
  message: Schema.String,
  remediation: Schema.String,
  stderr: Schema.String,
}) {}

export interface ScenarioStartOptions {
  /** Keep stdin open for writes. The default is EOF at spawn. */
  readonly stdin?: "pipe";
}

export interface ScenarioCliProcess {
  readonly command: readonly string[];
  /** Write and flush bytes to the child's input. */
  readonly write: (text: string) => Effect.Effect<void, ScenarioProcessError>;
  /** Send EOF. Repeated calls are safe. */
  readonly closeInput: Effect.Effect<void>;
  /** Find the first matching stdout line since spawn, with a bounded wait. */
  readonly stdoutLine: (
    matches: (line: string) => boolean,
    options?: { readonly timeoutMs?: number },
  ) => Effect.Effect<string, ScenarioProcessError>;
  /** Await exit and output, recording a run frame at most once. */
  readonly result: Effect.Effect<ScenarioRunResult, ScenarioProcessError>;
}

export const errorTagFromStderr = (stderr: string): string | undefined => {
  const match = /code:\s*([A-Za-z0-9_]+)/.exec(stderr) ?? /"code"\s*:\s*"([A-Za-z0-9_]+)"/.exec(stderr);
  return match?.[1];
};

type ChildEnvironment = Readonly<Record<string, string | undefined>>;

const sourceEnvKeys = [
  "PATH",
  "PATHEXT",
  "SystemRoot",
  "ComSpec",
  "WINDIR",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "LANDO_USER_DATA_ROOT",
  "LANDO_USER_CACHE_ROOT",
  "LANDO_USER_CONF_ROOT",
  "LANDO_SYSTEM_PLUGIN_ROOT",
] as const;

export const scenarioChild = (launcher: readonly string[], cwd: string, env: ChildEnvironment) => ({
  cmd: [...launcher],
  cwd,
  env: { ...env, PWD: cwd, BUN_BE_BUN: undefined, LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined },
  stdout: "pipe" as const,
  stderr: "pipe" as const,
});

// Inherit only OS process basics, not Docker/Podman endpoint or user configuration hints.
export const sourceChildEnvironment = (env: ChildEnvironment): ChildEnvironment =>
  Object.fromEntries(sourceEnvKeys.map((key) => [key, env[key]]));

const capture = (stream: ReadableStream<Uint8Array>) => {
  const decoder = new TextDecoder();
  const changed = new Set<() => void>();
  let revision = 0;
  const notify = () => {
    revision++;
    const waiters = [...changed];
    changed.clear();
    for (const wake of waiters) wake();
  };
  let text = "";
  let bytes = 0;
  let truncated = false;
  let done = false;
  let failed = false;
  const drain = (async () => {
    try {
      for await (const chunk of stream) {
        const remaining = outputLimit - bytes;
        if (remaining > 0) {
          text += decoder.decode(chunk.subarray(0, remaining), { stream: true });
          bytes += Math.min(chunk.byteLength, remaining);
        }
        if (chunk.byteLength > remaining) truncated = true;
        if (remaining > 0 || truncated) notify();
      }
      text += decoder.decode();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed = true;
    } finally {
      done = true;
      notify();
    }
  })();
  return {
    drain,
    snapshot: () => ({ text, truncated, done, failed, revision }),
    output: () => (truncated ? `${text}\n[scenario output truncated]\n` : text),
    awaitChange: (after: number) =>
      Effect.callback<void>((resume) => {
        if (after !== revision) return resume(Effect.void);
        const wake = () => resume(Effect.void);
        changed.add(wake);
        return Effect.sync(() => {
          changed.delete(wake);
        });
      }),
  };
};

type SpawnInput = ReturnType<typeof scenarioChild>;

export const startScenarioProcess = Effect.fnUntraced(function* (
  launch: SpawnInput,
  input: {
    readonly command: readonly string[];
    readonly stdin?: "pipe";
    readonly record?: (frame: ScenarioTranscriptFrame) => void;
  },
) {
  const error = (reason: ScenarioProcessError["reason"], message: string, remediation: string, stderr = "") =>
    new ScenarioProcessError({ reason, message, remediation, stderr });

  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn({ ...launch, stdin: input.stdin ?? "ignore" }),
      catch: () =>
        error(
          "spawn-failed",
          `Could not start ${launch.cmd[0]} in ${launch.cwd}.`,
          "Check that the CLI is executable and the working directory still exists.",
        ),
    }).pipe(
      Effect.map((proc) => {
        const stdout = capture(proc.stdout);
        const stderr = capture(proc.stderr);
        const started = performance.now();
        const settled = Promise.allSettled([proc.exited, stdout.drain, stderr.drain]).then(
          ([exit, out, err]) => {
            if (
              exit.status === "rejected" ||
              out.status === "rejected" ||
              err.status === "rejected" ||
              stdout.snapshot().failed ||
              stderr.snapshot().failed
            ) {
              return error(
                "output-failed",
                "Could not collect the CLI child result.",
                "Check the child process and its output pipes.",
                stderr.output(),
              );
            }
            const result: ScenarioRunResult = {
              command: input.command,
              stdout: stdout.output(),
              stderr: stderr.output(),
              exitCode: exit.value,
              ...(proc.signalCode === null ? {} : { signal: proc.signalCode }),
              events: [],
            };
            const tag = errorTagFromStderr(result.stderr);
            input.record?.({
              kind: "run",
              command: input.command,
              stdout: result.stdout,
              stderr: result.stderr,
              exit: result.exitCode,
              durationMs: Math.max(0, performance.now() - started),
            });
            return tag === undefined ? result : { ...result, _tag: tag };
          },
        );
        return { proc, stdout, stderr, settled };
      }),
    ),
    ({ proc, settled }) =>
      Effect.promise(() => {
        if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
        return settled;
      }),
  );

  const { proc, stdout, stderr, settled } = child;
  let stdin = proc.stdin;
  const inputClosed = () =>
    error(
      "input-closed",
      "The CLI child's stdin is closed.",
      "Start a new CLI child with piped stdin.",
      stderr.output(),
    );
  return {
    command: input.command,
    write: (text) =>
      Effect.tryPromise({
        try: async () => {
          if (stdin === undefined || proc.exitCode !== null || proc.signalCode !== null) throw inputClosed();
          const pipe = stdin;
          await pipe.write(text);
          await pipe.flush();
        },
        catch: inputClosed,
      }),
    closeInput: Effect.promise(async () => {
      const pipe = stdin;
      stdin = undefined;
      if (pipe !== undefined && proc.exitCode === null && proc.signalCode === null) await pipe.end();
    }),
    stdoutLine: (matches, options) =>
      Effect.gen(function* () {
        let start = 0;
        let scan = 0;
        while (true) {
          const { text, done, truncated, failed, revision } = stdout.snapshot();
          for (let end = text.indexOf("\n", scan); end !== -1; end = text.indexOf("\n", start)) {
            const line = text.slice(start, end).replace(/\r$/u, "");
            if (matches(line)) return line;
            start = end + 1;
          }
          scan = text.length;
          if (truncated)
            return yield* error(
              "output-limit",
              "Stdout capture limit reached before a matching line.",
              "Reduce the child's output.",
              stderr.output(),
            );
          if (failed)
            return yield* error(
              "output-failed",
              "Could not read CLI stdout.",
              "Check the child's stdout pipe.",
              stderr.output(),
            );
          if (done) {
            const last = text.slice(start);
            if (last !== "" && matches(last)) return last;
            return yield* error(
              "exited-before-match",
              "CLI stdout closed before a matching line.",
              "Check the command and the expected reply.",
              stderr.output(),
            );
          }
          yield* stdout.awaitChange(revision);
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: options?.timeoutMs ?? timeoutMs,
          orElse: () =>
            Effect.fail(
              error(
                "line-timeout",
                "Timed out waiting for a matching stdout line.",
                "Check the command and the expected reply.",
                stderr.output(),
              ),
            ),
        }),
      ),
    result: Effect.promise(() => settled).pipe(
      Effect.flatMap((result) =>
        result instanceof ScenarioProcessError ? Effect.fail(result) : Effect.succeed(result),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () =>
          Effect.fail(
            error(
              "exit-timeout",
              "Timed out waiting for the CLI child to exit.",
              "Close stdin before waiting for a stdio command to exit.",
              stderr.output(),
            ),
          ),
      }),
    ),
  } satisfies ScenarioCliProcess;
});
