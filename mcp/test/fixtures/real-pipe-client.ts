import { fileURLToPath } from "node:url";
import { Schema } from "effect";

export const fixturePath = fileURLToPath(new URL("./real-pipe-server.ts", import.meta.url));
export const sourceCommand = [process.execPath, fixturePath];

export async function deadline<A>(promise: Promise<A>, label: string, timeoutMs = 5_000): Promise<A> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Timed out: ${label}`)), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function startPipe(command: readonly string[], cwd: string) {
  const child = Bun.spawn([...command], { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const messages: Schema.JsonObject[] = [];
  const diagnostics: Schema.JsonObject[] = [];
  const waiters = new Set<() => void>();
  const stdout = child.stdout.getReader();
  const stderr = child.stderr.getReader();
  const ended = new Set<typeof stdout>();
  let readerError: unknown;
  const wake = () => {
    for (const waiter of waiters) waiter();
  };
  const consume = async (reader: typeof stdout, records: Schema.JsonObject[]) => {
    let pending = "";
    let bytes = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 65_536) throw new Error("Real-pipe fixture exceeded its output budget");
        pending += decoder.decode(chunk.value, { stream: true });
        let newline = pending.indexOf("\n");
        while (newline >= 0) {
          const line = pending.slice(0, newline);
          records.push(Schema.decodeUnknownSync(Schema.JsonObject)(JSON.parse(line)));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
          wake();
        }
      }
      pending += decoder.decode();
      if (pending.length > 0) throw new Error(`Unterminated fixture output: ${pending}`);
    } catch (error) {
      // Retain reader failures for wait/finish, rather than leaking a rejected background promise.
      readerError = error;
    } finally {
      ended.add(reader);
      wake();
    }
  };
  const readers = Promise.all([consume(stdout, messages), consume(stderr, diagnostics)]);
  const waitFor = async (predicate: () => boolean, channel: "stdout" | "stderr" = "stdout") => {
    let check: () => void = () => {};
    try {
      await deadline(
        new Promise<void>((resolve, reject) => {
          check = () => {
            if (readerError !== undefined) reject(readerError);
            else if (predicate()) resolve();
            else if (ended.has(channel === "stdout" ? stdout : stderr))
              reject(new Error(`Fixture ${channel} reached EOF before the expected record`));
          };
          waiters.add(check);
          check();
        }),
        `fixture record; stdout=${JSON.stringify(messages)} stderr=${JSON.stringify(diagnostics)}`,
      );
    } finally {
      waiters.delete(check);
    }
  };
  const send = async (value: Schema.JsonObject) => {
    child.stdin.write(`${JSON.stringify(value)}\n`);
    await deadline(Promise.resolve(child.stdin.flush()), "fixture stdin flush");
  };
  const response = async (id: string) => {
    await waitFor(() => messages.some((message) => message.id === id));
    const message = messages.find((message) => message.id === id);
    if (message === undefined) throw new Error(`Missing fixture response ${id}`);
    return message;
  };
  return {
    child,
    messages,
    diagnostics,
    send,
    response,
    waitFor,
    async closeInput() {
      await deadline(Promise.resolve(child.stdin.end()), "fixture stdin EOF");
    },
    async initialize() {
      await send({
        jsonrpc: "2.0",
        id: "initialize",
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "real-pipe-test", version: "1" },
        },
      });
      const initialized = await response("initialize");
      if (initialized.error !== undefined) throw new Error(JSON.stringify(initialized));
      await send({ jsonrpc: "2.0", method: "notifications/initialized" });
    },
    async finish() {
      const code = await deadline(child.exited, "fixture exit");
      await deadline(readers, "fixture stdout/stderr EOF");
      if (readerError !== undefined) throw readerError;
      return code;
    },
    async [Symbol.asyncDispose]() {
      try {
        if (child.exitCode === null) child.kill("SIGKILL");
        await deadline(child.exited, "fixture reap");
        await deadline(readers, "fixture reader reap");
      } finally {
        await deadline(Promise.all([stdout.cancel(), stderr.cancel()]), "fixture reader cancellation");
        stdout.releaseLock();
        stderr.releaseLock();
      }
    },
  };
}
