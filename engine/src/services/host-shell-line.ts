import { FileIoError, ShellExecError } from "@lando/sdk/errors";
import type { Redactor } from "@lando/sdk/secrets";
import type { ProcessResult } from "@lando/sdk/services";
import { type BunCommandRuntime, createBunCommandEnv } from "./bun-command-env.ts";
import {
  type CapturedHostExecutionContext,
  captureHostExecutionContext,
  prepareHostExecutionContext,
} from "./host-execution-context.ts";

export const hostShellError = (message: string, command: string, cause?: unknown): ShellExecError =>
  new ShellExecError({
    message,
    command,
    cause,
    remediation:
      cause instanceof FileIoError
        ? cause.remediation
        : "Fix the Bun Shell command so it succeeds in the reported working directory, then re-run.",
  });

export const redactHostShellError = (redactor: Redactor, error: ShellExecError): ShellExecError =>
  new ShellExecError({
    message: redactor.redactString(error.message),
    command: redactor.redactString(error.command),
    ...(error.cwd === undefined ? {} : { cwd: redactor.redactString(error.cwd) }),
    ...(error.exitCode === undefined ? {} : { exitCode: error.exitCode }),
    ...(error.stdout === undefined ? {} : { stdout: redactor.redactString(error.stdout) }),
    ...(error.stderr === undefined ? {} : { stderr: redactor.redactString(error.stderr) }),
    cause: redactor.redactValue(error.cause),
    remediation: redactor.redactString(error.remediation),
  });

const EVALUATOR = [
  'import { $ } from "bun";',
  "delete process.env.BUN_BE_BUN;",
  "delete process.env.BUN_FEATURE_FLAG_NO_ORPHANS;",
  'process.on("message", async (message) => {',
  '  if (typeof message === "object" && message !== null && message.type === "abort") process.exit(130);',
  '  if (typeof message !== "object" || message === null || message.type !== "run" || !Array.isArray(message.fragments) || !message.fragments.every((fragment) => typeof fragment === "string") || !Array.isArray(message.values) || !message.values.every((value) => typeof value === "string")) process.exit(2);',
  '  Object.defineProperty(message.fragments, "raw", { value: message.fragments });',
  "  const result = await $(message.fragments, ...message.values).nothrow();",
  "  process.exit(result.exitCode);",
  "});",
].join("\n");

export interface HostShellLineOptions {
  readonly fragments: ReadonlyArray<string>;
  readonly values: ReadonlyArray<string>;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly runtime?: BunCommandRuntime;
  readonly signal?: AbortSignal;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
}

const collect = async (stream: ReadableStream<Uint8Array>, write: (chunk: string) => void): Promise<void> => {
  const decoder = new TextDecoder();
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    write(text);
  }
  const tail = decoder.decode();
  if (tail.length > 0) write(tail);
};

export const runHostShellLine = async (
  options: HostShellLineOptions,
  captured: CapturedHostExecutionContext = captureHostExecutionContext(options),
): Promise<ProcessResult> => {
  if (options.signal?.aborted) return { exitCode: 130, stdout: "", stderr: "" };
  const context = await prepareHostExecutionContext(captured);
  options.signal?.throwIfAborted();
  await using launcher = await createBunCommandEnv(
    {
      command: "bun",
      env: {
        ...context.env,
        BUN_BE_BUN: "1",
      },
      cwd: context.cwd,
    },
    options.runtime,
  );
  options.signal?.throwIfAborted();
  const evaluatorArgv = hostShellEvaluatorArgv();
  const child = Bun.spawn({
    cmd: [...evaluatorArgv],
    cwd: context.cwd,
    env: launcher.env,
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    ipc: () => {},
  });
  let interrupted = false;
  let commandSent = false;
  let termination: Promise<void> | undefined;
  const terminate = (): Promise<void> => {
    if (termination !== undefined) return termination;
    termination = (async () => {
      if (process.platform === "win32") {
        const taskkill = Bun.spawn({
          cmd: ["taskkill.exe", "/PID", String(child.pid), "/T", "/F"],
          stdin: "ignore",
          stdout: "ignore",
          stderr: "ignore",
        });
        await taskkill.exited;
      } else {
        child.kill();
      }
      await child.exited;
    })();
    return termination;
  };
  const abort = (): void => {
    interrupted = true;
    if (process.platform !== "win32" && commandSent && child.exitCode === null) {
      child.send({ type: "abort" });
    } else {
      void terminate();
    }
  };
  const stdout = collect(child.stdout, options.writeStdout);
  const stderr = collect(child.stderr, options.writeStderr);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted === true) abort();
    else {
      child.send({ type: "run", fragments: options.fragments, values: options.values });
      commandSent = true;
    }
    const [code] = await Promise.all([child.exited, stdout, stderr]);
    return { exitCode: interrupted ? 130 : code, stdout: "", stderr: "" };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) await terminate();
    await Promise.allSettled([child.exited, stdout, stderr]);
  }
};

export const hostShellEvaluatorArgv = (): ReadonlyArray<string> => [
  process.execPath,
  ...(process.platform === "win32" ? [] : ["--no-orphans"]),
  "--eval",
  EVALUATOR,
];
