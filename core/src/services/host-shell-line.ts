import type { ProcessResult } from "@lando/sdk/services";

const EVALUATOR = [
  'import { $ } from "bun";',
  "delete process.env.BUN_BE_BUN;",
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

export const runHostShellLine = async (options: HostShellLineOptions): Promise<ProcessResult> => {
  const evaluatorArgv = hostShellEvaluatorArgv();
  const child = Bun.spawn({
    cmd: [...evaluatorArgv],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env, BUN_BE_BUN: "1" },
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
