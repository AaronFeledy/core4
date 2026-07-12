import { Effect, Stream } from "effect";

import { ProviderInternalError, ProviderUnavailableError } from "@lando/sdk/errors";
import type { ProviderError } from "@lando/sdk/services";

import { AsyncQueue } from "./async-queue.ts";
import { makeHelperExecOutputDecoder } from "./log-file-exec-output.ts";

const encoder = new TextEncoder();
const maxFrameBytes = 1_048_576;

type Command = Readonly<Record<string, string | number>>;
type ResponseItem =
  | { readonly kind: "line"; readonly line: string }
  | { readonly kind: "error"; readonly error: ProviderError };

const internal = (providerId: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderInternalError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const unavailable = (providerId: string, message: string, details?: unknown, cause?: unknown) =>
  new ProviderUnavailableError({
    providerId,
    operation: "logFileAccess",
    message,
    ...(details === undefined ? {} : { details }),
    ...(cause === undefined ? {} : { cause }),
  });

const lineBytes = (value: Command): Uint8Array => encoder.encode(`${JSON.stringify(value)}\n`);

const stdinLines = (queue: AsyncQueue<Uint8Array>): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    for await (const chunk of queue) yield chunk;
  },
});

export class HelperSession {
  private readonly input = new AsyncQueue<Uint8Array>();
  private readonly responses = new AsyncQueue<ResponseItem>();
  private readonly controller = new AbortController();
  private readonly decoder = new TextDecoder();
  private readonly decodeOutput: ReturnType<typeof makeHelperExecOutputDecoder>;
  private buffered = "";
  private closed = false;
  private closePromise: Promise<void> | undefined;

  constructor(
    private readonly providerId: string,
    start: (
      stdin: AsyncIterable<Uint8Array>,
      signal: AbortSignal,
    ) => Stream.Stream<Uint8Array, ProviderError>,
  ) {
    this.decodeOutput = makeHelperExecOutputDecoder(providerId);
    void Effect.runPromiseExit(
      start(this.stdin, this.signal).pipe(
        Stream.runForEach((chunk) => Effect.sync(() => this.feedOutput(chunk))),
      ),
    ).then((exit) => {
      if (exit._tag === "Failure") {
        this.responses.push({
          kind: "error",
          error: unavailable(providerId, "Log helper exec stream failed.", exit.cause),
        });
      }
      this.responses.close();
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get stdin(): AsyncIterable<Uint8Array> {
    return stdinLines(this.input);
  }

  send(command: Command): Effect.Effect<unknown, ProviderError> {
    return Effect.tryPromise({
      try: async () => {
        this.input.push(lineBytes(command));
        const item = await this.next();
        if (item.kind === "error") throw item.error;
        return JSON.parse(item.line);
      },
      catch: (cause) =>
        cause instanceof ProviderInternalError || cause instanceof ProviderUnavailableError
          ? cause
          : internal(this.providerId, "Corrupt log helper protocol frame.", undefined, cause),
    });
  }

  close(): Effect.Effect<void> {
    return Effect.promise(() => {
      if (this.closePromise === undefined) this.closePromise = this.closeOnce();
      return this.closePromise;
    });
  }

  private async closeOnce(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      this.input.push(lineBytes({ op: "close" }));
      await Promise.race([
        this.next().catch(() => undefined),
        new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
      ]);
    }
    this.input.close();
    this.controller.abort();
  }

  private async next(): Promise<ResponseItem> {
    for await (const item of this.responses) return item;
    return {
      kind: "error",
      error: unavailable(this.providerId, "Log helper exec session ended before responding."),
    };
  }

  private feedOutput(chunk: Uint8Array): void {
    for (const output of this.decodeOutput(chunk)) {
      if (output.kind === "error") this.responses.push({ kind: "error", error: output.error });
      else this.feedJson(output.payload);
    }
  }

  private feedJson(chunk: Uint8Array): void {
    this.buffered += this.decoder.decode(chunk, { stream: true });
    while (true) {
      const newline = this.buffered.indexOf("\n");
      if (newline < 0) {
        if (this.buffered.length > maxFrameBytes) {
          this.responses.push({
            kind: "error",
            error: internal(this.providerId, "Log helper frame exceeded size bound."),
          });
        }
        return;
      }
      const line = this.buffered.slice(0, newline);
      this.buffered = this.buffered.slice(newline + 1);
      if (line.length > maxFrameBytes) {
        this.responses.push({
          kind: "error",
          error: internal(this.providerId, "Log helper frame exceeded size bound."),
        });
      } else if (line.length > 0) {
        this.responses.push({ kind: "line", line });
      }
    }
  }
}
