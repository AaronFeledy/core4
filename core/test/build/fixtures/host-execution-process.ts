import { expect } from "bun:test";

const OUTPUT_LIMIT = 128 * 1024;
export const hostDirectoryProbe =
  'echo "ACTUAL=$(pwd)"; echo "ENV=<$PWD>"; bun -e \'console.log("IDENTITY="+require("node:fs").readFileSync(".host-marker","utf8"))\'';

export const runCaptured = async (cmd: readonly string[], cwd: string, env: NodeJS.ProcessEnv) => {
  const controller = new AbortController();
  const child = Bun.spawn({
    cmd: [...cmd],
    cwd,
    env,
    signal: controller.signal,
    timeout: 30_000,
    stdout: "pipe",
    stderr: "pipe",
  });
  const capture = async (stream: ReadableStream<Uint8Array>): Promise<string> => {
    const decoder = new TextDecoder();
    let text = "";
    for await (const chunk of stream) {
      text += decoder.decode(chunk, { stream: true });
      if (text.length > OUTPUT_LIMIT) {
        controller.abort();
        throw new RangeError("Host acceptance output exceeded its capture limit");
      }
    }
    return text + decoder.decode();
  };
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      capture(child.stdout),
      capture(child.stderr),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
};

export const runHostShellPty = async (
  binary: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<string> => {
  let output = "";
  let changed = Promise.withResolvers<void>();
  const decoder = new TextDecoder();
  const child = Bun.spawn({
    cmd: [binary, "shell", "--no-history", "--renderer=plain"],
    cwd,
    env,
    timeout: 30_000,
    terminal: {
      cols: 160,
      rows: 30,
      data: (_terminal, bytes) => {
        output = (output + decoder.decode(bytes, { stream: true })).slice(-OUTPUT_LIMIT);
        changed.resolve();
        changed = Promise.withResolvers<void>();
      },
    },
  });
  const exited = child.exited.then(() => {
    throw new Error(`Host shell exited before expected terminal output: ${output}`);
  });
  // The rejection is also consumed when exit is requested after the last output wait.
  void exited.catch(() => undefined);
  const waitFor = async (pattern: RegExp): Promise<void> => {
    while (!pattern.test(output)) await Promise.race([changed.promise, exited]);
  };
  try {
    await waitFor(/lando> /);
    child.terminal?.write(`${hostDirectoryProbe}\n`);
    await waitFor(/\r?\nIDENTITY=[^\r\n]+\r?\n[\s\S]*lando> /);
    child.terminal?.write("exit\n");
    expect(await child.exited, output).toBe(0);
    return output;
  } finally {
    child.terminal?.close();
    if (child.exitCode === null) child.kill();
    await child.exited;
  }
};
