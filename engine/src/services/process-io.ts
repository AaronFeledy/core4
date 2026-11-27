import type { ProcessSpawnOptions } from "@lando/sdk/services";
import { processCancellation } from "./process-cancellation.ts";

interface BunFileSink {
  write: (chunk: string | Uint8Array) => number | Promise<number>;
  flush?: () => number | Promise<number>;
  end: () => number | Promise<number>;
}

export const pipedOutput = (stream: unknown): ReadableStream<Uint8Array> | undefined =>
  stream instanceof ReadableStream ? stream : undefined;

export const readProcessText = async (
  stream: unknown,
  signal: AbortSignal,
  countPrivateBytes?: (chunk: Uint8Array) => void,
): Promise<string> => {
  const piped = pipedOutput(stream);
  if (piped === undefined) return "";
  const reader = piped.getReader();
  const chunks: Uint8Array[] = [];
  let abandoned = false;
  const cancel = () => {
    abandoned = true;
    // Cancelling releases outstanding reads even if a descendant still holds the write end.
    void reader.cancel().catch(() => undefined);
  };
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      countPrivateBytes?.(next.value);
      chunks.push(next.value);
    }
  } catch (cause) {
    cancel();
    throw cause;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
  // A forced reader close is not EOF. Never return dropped output as a completed result.
  if (abandoned) throw processCancellation;
  return new TextDecoder("utf-8", { ignoreBOM: countPrivateBytes !== undefined }).decode(
    Buffer.concat(chunks),
  );
};

const isBrokenPipe = (cause: unknown): boolean =>
  typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EPIPE";

export const awaitSinkResult = async (
  result: number | Promise<number>,
  exited: Promise<number>,
): Promise<void> => {
  const settled = Promise.resolve(result).then(
    () => ({ kind: "settled" as const }),
    (cause: unknown) => ({ kind: "failed" as const, cause }),
  );
  const first = await Promise.race([settled, exited.then(() => ({ kind: "exited" as const }))]);
  // Bun may reject the sink just after exit; observe it without waiting on a stuck sink.
  const outcome =
    first.kind === "exited"
      ? await Promise.race([settled, Bun.sleep(25).then(() => ({ kind: "pending" as const }))])
      : first;
  if (outcome.kind === "failed") throw outcome.cause;
};

export const pumpStdin = async (
  child: {
    readonly stdin: BunFileSink | number | null | undefined;
    readonly exited: Promise<number>;
    readonly exitCode: number | null;
  },
  input: ProcessSpawnOptions,
): Promise<void> => {
  const sink = child.stdin;
  if (sink === undefined || sink === null || typeof sink === "number") return;
  const exited = child.exited;
  const exitedAfterBrokenPipe = async (): Promise<boolean> =>
    typeof child.exitCode === "number" ||
    (await Promise.race([exited.then(() => true), Bun.sleep(25).then(() => false)]));
  if (input.stdinStream === undefined) {
    if (input.stdin === undefined) return;
    try {
      await awaitSinkResult(
        sink.write(typeof input.stdin === "string" ? new TextEncoder().encode(input.stdin) : input.stdin),
        exited,
      );
      const flushed = sink.flush?.();
      if (flushed !== undefined) await awaitSinkResult(flushed, exited);
      await awaitSinkResult(sink.end(), exited);
    } catch (cause) {
      if (!isBrokenPipe(cause) || !(await exitedAfterBrokenPipe())) throw cause;
    }
    return;
  }
  const iterator = input.stdinStream[Symbol.asyncIterator]();
  let finished = false;
  try {
    while (true) {
      const next = await Promise.race([
        iterator.next().then((value) => ({ kind: "chunk" as const, value })),
        exited.then(() => ({ kind: "exited" as const })),
      ]);
      if (next.kind === "exited") return;
      if (next.value.done) {
        finished = true;
        try {
          await awaitSinkResult(sink.end(), exited);
        } catch (cause) {
          if (!isBrokenPipe(cause) || !(await exitedAfterBrokenPipe())) throw cause;
        }
        return;
      }
      input.signal?.throwIfAborted();
      try {
        await awaitSinkResult(sink.write(next.value.value), exited);
        const flushed = sink.flush?.();
        if (flushed !== undefined) await awaitSinkResult(flushed, exited);
      } catch (cause) {
        if (!isBrokenPipe(cause) || !(await exitedAfterBrokenPipe())) throw cause;
        return;
      }
    }
  } finally {
    if (!finished) {
      try {
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // Child exit owns completion; iterator cleanup must not mask it.
      }
    }
  }
};
