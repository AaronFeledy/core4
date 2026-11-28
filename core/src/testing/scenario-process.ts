import { Effect, Schema } from "effect";
import type { ScenarioCliProcess, ScenarioRunResult, ScenarioTranscriptFrame } from "./scenario-context";

const outputLimit = 8 * 1024 * 1024;
const timeoutMs = 20_000;
const expectedReply = "Check the command and the expected reply.";
const failureDetails = {
  "input-closed": ["The CLI child's stdin is closed.", "Start a new CLI child with piped stdin."],
  "line-timeout": ["Timed out waiting for a matching stdout line.", expectedReply],
  "exited-before-match": ["CLI stdout closed before a matching line.", expectedReply],
  "exit-timeout": ["Timed out waiting for the CLI child to exit.", "Close stdin before waiting for exit."],
  "output-limit": ["Stdout capture limit reached before a matching line.", "Reduce the child's output."],
  "output-failed": [
    "Could not read the CLI child's output.",
    "Check the child process and its output pipes.",
  ],
} as const;

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

export const scenarioChild = (
  launcher: readonly string[],
  {
    cwd,
    env,
    mode,
  }: { readonly cwd: string; readonly env: ChildEnvironment; readonly mode: "host-only" | "compiled" },
) => ({
  cmd: [...launcher],
  cwd,
  env: {
    // Source children inherit OS process basics, not endpoint or configuration hints.
    ...(mode === "host-only" ? Object.fromEntries(sourceEnvKeys.map((key) => [key, env[key]])) : env),
    PWD: cwd,
    BUN_BE_BUN: undefined,
    LANDO_DISALLOW_BUN_BE_BUN_REENTRY: undefined,
  },
  stdout: "pipe" as const,
  stderr: "pipe" as const,
});

const capture = (stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
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
      while (true) {
        const { done, value: chunk } = await reader.read();
        if (done) break;
        const remaining = outputLimit - bytes;
        if (remaining > 0) {
          const retained = chunk.subarray(0, remaining);
          text += decoder.decode(retained, { stream: true });
          bytes += retained.byteLength;
        }
        truncated ||= chunk.byteLength > remaining;
        if (remaining > 0 || truncated) notify();
      }
      text += decoder.decode();
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      failed = true;
    } finally {
      reader.releaseLock();
      done = true;
      notify();
    }
  })();
  return {
    drain,
    stop: () => (done ? Promise.resolve() : reader.cancel()),
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
const stillRunning = (proc: Pick<Bun.Subprocess, "exitCode" | "signalCode">) =>
  proc.exitCode === null && proc.signalCode === null;

const processError = (reason: keyof typeof failureDetails, stderr: string) => {
  const [message, remediation] = failureDetails[reason];
  return new ScenarioProcessError({ reason, message, remediation, stderr });
};

export const startScenarioProcess = Effect.fnUntraced(function* (
  launch: SpawnInput,
  input: {
    readonly command: readonly string[];
    readonly stdin?: "pipe";
    readonly record?: (frame: ScenarioTranscriptFrame) => void;
  },
) {
  const child = yield* Effect.acquireRelease(
    Effect.try({
      try: () => Bun.spawn({ ...launch, stdin: input.stdin ?? "ignore" }),
      catch: () =>
        new ScenarioProcessError({
          reason: "spawn-failed",
          message: `Could not start ${launch.cmd[0]} in ${launch.cwd}.`,
          remediation: "Check that the CLI is executable and the working directory still exists.",
          stderr: "",
        }),
    }).pipe(
      Effect.map((proc) => {
        const stdout = capture(proc.stdout);
        const stderr = capture(proc.stderr);
        const started = performance.now();
        const outputFailure = () => processError("output-failed", stderr.output());
        const settled = Promise.all([proc.exited, stdout.drain, stderr.drain]).then(([exitCode]) => {
          if (stdout.snapshot().failed || stderr.snapshot().failed) return outputFailure();
          const result: ScenarioRunResult = {
            command: input.command,
            stdout: stdout.output(),
            stderr: stderr.output(),
            exitCode,
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
        }, outputFailure);
        return { proc, stdout, stderr, settled };
      }),
    ),
    ({ proc, settled, stdout, stderr }) =>
      Effect.promise(async () => {
        if (stillRunning(proc)) proc.kill("SIGKILL");
        await proc.exited;
        // A descendant may still own a pipe after the CLI itself has exited.
        await Promise.allSettled([stdout.stop(), stderr.stop()]);
        return settled;
      }),
  );

  const { proc, stdout, stderr, settled } = child;
  let stdin = proc.stdin;
  const failure = (reason: keyof typeof failureDetails) => processError(reason, stderr.output());
  return {
    command: input.command,
    write: (text) =>
      Effect.suspend(() => {
        const pipe = stdin;
        if (pipe === undefined || !stillRunning(proc)) return Effect.fail(failure("input-closed"));
        return Effect.tryPromise({
          try: async () => {
            await pipe.write(text);
            await pipe.flush();
          },
          catch: () => failure("input-closed"),
        });
      }),
    closeInput: Effect.promise(async () => {
      const pipe = stdin;
      stdin = undefined;
      if (pipe !== undefined && stillRunning(proc)) await pipe.end();
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
          if (truncated) return yield* failure("output-limit");
          if (failed) return yield* failure("output-failed");
          if (done) {
            const last = text.slice(start);
            if (last !== "" && matches(last)) return last;
            return yield* failure("exited-before-match");
          }
          yield* stdout.awaitChange(revision);
        }
      }).pipe(
        Effect.timeoutOrElse({
          duration: options?.timeoutMs ?? timeoutMs,
          orElse: () => Effect.fail(failure("line-timeout")),
        }),
      ),
    result: Effect.promise(() => settled).pipe(
      Effect.flatMap((result) =>
        result instanceof ScenarioProcessError ? Effect.fail(result) : Effect.succeed(result),
      ),
      Effect.timeoutOrElse({
        duration: timeoutMs,
        orElse: () => Effect.fail(failure("exit-timeout")),
      }),
    ),
  } satisfies ScenarioCliProcess;
});
