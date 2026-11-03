import { createInterface } from "node:readline";

import type { ShellReplIO, ShellReplInput } from "@lando/sdk/services";

type Resume = (result: IteratorResult<ShellReplInput>) => void;

/** The terminal streams the REPL reads and writes; process stdin and stdout by default. */
export interface ShellReplStreams {
  readonly input: NodeJS.ReadableStream & {
    readonly isTTY?: boolean;
    readonly isRaw?: boolean;
    readonly setRawMode?: (mode: boolean) => unknown;
    readonly unref?: () => void;
  };
  readonly output: NodeJS.WritableStream;
}

export const makeProcessShellReplIO = (
  streams: ShellReplStreams = { input: process.stdin, output: process.stdout },
): ShellReplIO => {
  const output = streams.output;
  const inputStream = streams.input;
  const pending: ShellReplInput[] = [];
  const waiters: Resume[] = [];
  let closed = false;
  const push = (event: ShellReplInput): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) pending.push(event);
    else waiter({ done: false, value: event });
  };
  const terminal = createInterface({ input: inputStream, output, terminal: true });
  terminal.setPrompt("lando> ");
  terminal.on("line", (line) => push({ _tag: "line", line }));
  terminal.on("SIGINT", () => push({ _tag: "interrupt" }));
  terminal.on("close", () => {
    if (!closed) push({ _tag: "eof" });
  });
  const input: AsyncIterable<ShellReplInput> = {
    [Symbol.asyncIterator]: () => ({
      next: () => {
        const event = pending.shift();
        if (event !== undefined) return Promise.resolve({ done: false, value: event });
        if (closed) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<ShellReplInput>>((resolve) => waiters.push(resolve));
      },
    }),
  };
  terminal.prompt();
  return {
    input,
    writeStdout: (chunk) => output.write(chunk),
    writeStderr: (chunk) => output.write(chunk),
    prompt: (initial) => {
      if (closed) return;
      terminal.prompt();
      // Pre-fill only an empty single-line buffer, so typed-ahead input is never merged or submitted.
      if (initial !== undefined && pending.length === 0 && terminal.line === "" && !/[\r\n]/u.test(initial))
        terminal.write(initial);
    },
    close: () => {
      if (closed) return;
      closed = true;
      terminal.close();
      terminal.removeAllListeners();
      if (
        inputStream.isTTY === true &&
        inputStream.isRaw === true &&
        typeof inputStream.setRawMode === "function"
      ) {
        inputStream.setRawMode(false);
      }
      inputStream.pause();
      if (typeof inputStream.unref === "function") inputStream.unref();
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
  };
};
