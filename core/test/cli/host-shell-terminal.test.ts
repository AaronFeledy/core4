import { expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import type { ShellReplInput } from "@lando/sdk/services";

import { makeProcessShellReplIO } from "../../src/cli/host-shell-terminal.ts";

const terminal = () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let echoed = "";
  const echoWaiters: Array<{ readonly text: string; readonly resolve: () => void }> = [];
  output.on("data", (chunk: Buffer) => {
    echoed += chunk.toString();
    for (const waiter of echoWaiters.splice(0))
      if (echoed.includes(waiter.text)) waiter.resolve();
      else echoWaiters.push(waiter);
  });
  const io = makeProcessShellReplIO({ input, output });
  const lines = io.input[Symbol.asyncIterator]();
  const nextLine = async (): Promise<ShellReplInput | undefined> => (await lines.next()).value;
  const type = (text: string) => input.write(text);
  /** Resolves once readline has echoed `text`, so it's in the line buffer. */
  const echoedText = (text: string) =>
    echoed.includes(text)
      ? Promise.resolve()
      : new Promise<void>((resolve) => echoWaiters.push({ text, resolve }));
  return { io, nextLine, type, echoedText };
};

test("Enter submits the pre-filled correction as typed text", async () => {
  // Given
  const { io, nextLine, type } = terminal();
  try {
    // When the REPL offers a corrected line and the user presses Enter
    io.prompt?.("echo $HOME 1>&2");
    type("\r");
    // Then
    expect(await nextLine()).toEqual({ _tag: "line", line: "echo $HOME 1>&2" });
  } finally {
    io.close?.();
  }
});

test("the user can edit the pre-filled line before submitting it", async () => {
  // Given
  const { io, nextLine, type } = terminal();
  try {
    // When
    io.prompt?.("echo $HOME 1>&2");
    type(" # edited\r");
    // Then
    expect(await nextLine()).toEqual({ _tag: "line", line: "echo $HOME 1>&2 # edited" });
  } finally {
    io.close?.();
  }
});

test("typed-ahead input is never merged with a pre-fill", async () => {
  // Given the user already typed part of a line
  const { io, nextLine, type, echoedText } = terminal();
  try {
    type("ls");
    await echoedText("ls");
    // When
    io.prompt?.("echo $HOME 1>&2");
    type("\r");
    // Then their text is submitted on its own
    expect(await nextLine()).toEqual({ _tag: "line", line: "ls" });
  } finally {
    io.close?.();
  }
});

test("multiline text is never pre-filled, so nothing submits itself", async () => {
  // Given
  const { io, nextLine, type } = terminal();
  try {
    // When
    io.prompt?.("echo one\recho two");
    type("pwd\r");
    // Then only what the user typed arrives
    expect(await nextLine()).toEqual({ _tag: "line", line: "pwd" });
  } finally {
    io.close?.();
  }
});
