import type { ProcessResult } from "@lando/sdk/services";

const EVALUATOR = [
  'import { $ } from "bun";',
  "delete process.env.BUN_BE_BUN;",
  'process.on("message", async (message) => {',
  '  if (typeof message !== "object" || message === null || message.type !== "run" || typeof message.line !== "string") process.exit(2);',
  "  const result = await $`${{ raw: message.line }}`.nothrow();",
  "  process.exit(result.exitCode);",
  "});",
].join("\n");

export interface HostShellLineOptions {
  readonly line: string;
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly writeStdout: (chunk: string) => void;
  readonly writeStderr: (chunk: string) => void;
}

const collect = async (
  stream: ReadableStream<Uint8Array>,
  write: (chunk: string) => void,
): Promise<string> => {
  const decoder = new TextDecoder();
  let output = "";
  for await (const chunk of stream) {
    const text = decoder.decode(chunk, { stream: true });
    output += text;
    write(text);
  }
  const tail = decoder.decode();
  output += tail;
  if (tail.length > 0) write(tail);
  return output;
};

export const runHostShellLine = async (options: HostShellLineOptions): Promise<ProcessResult> => {
  const child = Bun.spawn({
    cmd: [process.execPath, "--eval", EVALUATOR],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    env: { ...process.env, ...options.env, BUN_BE_BUN: "1" },
    stdin: "inherit",
    stdout: "pipe",
    stderr: "pipe",
    ipc: () => {},
  });
  let interrupted = false;
  const abort = (): void => {
    interrupted = true;
    child.kill();
  };
  const stdout = collect(child.stdout, options.writeStdout);
  const stderr = collect(child.stderr, options.writeStderr);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    if (options.signal?.aborted === true) abort();
    else child.send({ type: "run", line: options.line });
    const [code, capturedStdout, capturedStderr] = await Promise.all([child.exited, stdout, stderr]);
    return { exitCode: interrupted ? 130 : code, stdout: capturedStdout, stderr: capturedStderr };
  } finally {
    options.signal?.removeEventListener("abort", abort);
    if (child.exitCode === null) child.kill();
    await Promise.allSettled([child.exited, stdout, stderr]);
  }
};

export const hostShellEvaluatorArgv = (): ReadonlyArray<string> => [process.execPath, "--eval", EVALUATOR];
