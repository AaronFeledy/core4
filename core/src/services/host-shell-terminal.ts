import { createInterface } from "node:readline";

import type { ShellReplIO, ShellReplInput } from "@lando/sdk/services";

type Resume = (result: IteratorResult<ShellReplInput>) => void;

export const makeProcessShellReplIO = (): ShellReplIO => {
  const output = process.stdout;
  const pending: ShellReplInput[] = [];
  const waiters: Resume[] = [];
  let closed = false;
  const push = (event: ShellReplInput): void => {
    const waiter = waiters.shift();
    if (waiter === undefined) pending.push(event);
    else waiter({ done: false, value: event });
  };
  const terminal = createInterface({ input: process.stdin, output, terminal: true });
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
    prompt: () => terminal.prompt(),
    close: () => {
      closed = true;
      terminal.close();
      for (const waiter of waiters.splice(0)) waiter({ done: true, value: undefined });
    },
  };
};
