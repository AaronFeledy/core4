import type { ProcessSpawnOptions } from "@lando/sdk/services";

interface BunFileSink {
  write: (chunk: string | Uint8Array) => number | Promise<number>;
  flush?: () => number | Promise<number>;
  end: () => number | Promise<number>;
}

export const pipedOutput = (stream: unknown): ReadableStream<Uint8Array> | undefined =>
  stream instanceof ReadableStream ? stream : undefined;

export const readText = (stream: unknown): Promise<string> => {
  const piped = pipedOutput(stream);
  return piped === undefined ? Promise.resolve("") : new Response(piped).text();
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
    for (;;) {
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
