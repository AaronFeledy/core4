import { expect, test } from "bun:test";
import type { McpTransportError } from "@lando/sdk/errors";
import { Deferred, Effect, Fiber, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { TestClock } from "effect/testing";
import { guardStdio } from "../src/stdio-guard";
import { makeStdioClient } from "../src/testing";
import { expectMcpTransportFailure } from "./stdio-transport-test-support";

const controlledOutput = Effect.fnUntraced(function* () {
  const client = yield* makeStdioClient();
  const terminal = yield* Deferred.make<void, McpTransportError>();
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const chunks: string[] = [];
  let calls = 0;
  const guarded = yield* guardStdio(
    Stdio.make({
      ...client.stdio,
      stdout: () =>
        forEachChunk((chunk: string | Uint8Array) =>
          Effect.gen(function* () {
            calls++;
            const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
            chunks.push(text.slice(0, 5));
            yield* Deferred.succeed(started, undefined);
            yield* Deferred.await(release).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)));
            chunks.push(text.slice(5));
          }),
        ),
    }),
    terminal,
  );
  const write = (text: string) => Stream.run(Stream.make(text), guarded.stdio.stdout());
  return { client, terminal, guarded, started, release, stopped, chunks, write, calls: () => calls };
});

for (const shutdown of ["EOF", "interrupt"] as const) {
  test(`admitted frame finishes once when ${shutdown} abandons queued output`, async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Given a raw writer held after a byte prefix and another writer waiting for its lane.
          const output = yield* controlledOutput();
          const frame = '{"jsonrpc":"2.0","id":"admitted","result":{}}\n';
          const first = yield* output.write(frame).pipe(Effect.forkScoped);
          yield* Deferred.await(output.started);
          const queued = yield* output.write("queued\n").pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          // When shutdown closes admission and interrupts the writer supervisor.
          if (shutdown === "EOF") {
            const reader = yield* Stream.runDrain(output.guarded.stdio.stdin).pipe(Effect.forkScoped);
            yield* output.client.close;
            yield* Deferred.await(output.terminal);
            yield* Fiber.join(reader);
          } else yield* output.guarded.close;
          const interrupted = yield* Fiber.interrupt(first).pipe(Effect.forkScoped);
          if (shutdown === "interrupt") yield* Fiber.interrupt(queued);
          yield* Deferred.succeed(output.release, undefined);
          yield* Fiber.join(interrupted);
          yield* Fiber.await(queued);
          yield* output.write("late\n");
          // Then only the admitted frame reaches raw stdout, without replay or a partial frame.
          return { text: output.chunks.join(""), calls: output.calls(), frame };
        }),
      ),
    );
    expect(observed.text).toBe(observed.frame);
    expect(observed.calls).toBe(1);
  });
}

test("closing before execution rejects a previously constructed write", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given a lazy write constructed while the session is open.
        const output = yield* controlledOutput();
        const pending = output.write("unadmitted\n");
        // When admission closes before execution.
        yield* output.guarded.close;
        yield* pending;
        // Then the raw writer never starts.
        return output.calls();
      }),
    ),
  );
  expect(observed).toBe(0);
});

test("admitted write retains its original deadline across interruption and cancels raw IO", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given a blocked write that has consumed four seconds of its deadline.
        const output = yield* controlledOutput();
        const writer = yield* output.write("blocked\n").pipe(Effect.forkScoped);
        yield* Deferred.await(output.started);
        yield* TestClock.adjust("4 seconds");
        expect(yield* Deferred.isDone(output.stopped)).toBe(false);
        // When shutdown interrupts its supervisor and the original fifth second expires.
        yield* output.guarded.close;
        const interrupted = yield* Fiber.interrupt(writer).pipe(Effect.forkScoped);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(output.stopped);
        yield* Fiber.join(interrupted);
        // Then timeout, not a restarted deadline or an immortal raw worker, ends the write.
        return yield* Effect.exit(Deferred.await(output.terminal));
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
  expect(expectMcpTransportFailure(observed)?.message).toBe(
    "MCP stdio stdout write exceeded the 5 second deadline.",
  );
});

test("clean EOF remains the first terminal outcome when an admitted write later times out", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given an admitted writer and active input reader.
        const output = yield* controlledOutput();
        const writer = yield* output.write("blocked\n").pipe(Effect.forkScoped);
        yield* Deferred.await(output.started);
        const reader = yield* Stream.runDrain(output.guarded.stdio.stdin).pipe(Effect.forkScoped);
        // When EOF succeeds before the write deadline.
        yield* output.client.close;
        yield* Deferred.await(output.terminal);
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(writer);
        yield* Fiber.join(reader);
        // Then a late timeout cannot replace clean EOF.
        return yield* Effect.exit(Deferred.await(output.terminal));
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
  expect(observed._tag).toBe("Success");
});

test("malformed JSON waits for the stdout lane without interleaving a parse-error frame", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given a writer held after a prefix, and malformed input on the independent parse path.
        const output = yield* controlledOutput();
        const frame = '{"jsonrpc":"2.0","id":1,"result":{}}\n';
        const writer = yield* output.write(frame).pipe(Effect.forkScoped);
        yield* Deferred.await(output.started);
        const reader = yield* Stream.runDrain(output.guarded.stdio.stdin).pipe(Effect.forkScoped);
        yield* output.client.raw(new TextEncoder().encode("{bad}\n"));
        yield* Effect.yieldNow;
        const callsWhileBlocked = output.calls();
        // When the admitted frame is released.
        yield* Deferred.succeed(output.release, undefined);
        yield* Fiber.join(writer);
        yield* Fiber.join(reader);
        // Then both complete frames are serialized and the parse failure is retained.
        return {
          callsWhileBlocked,
          text: output.chunks.join(""),
          frame,
          exit: yield* Effect.exit(Deferred.await(output.terminal)),
        };
      }),
    ),
  );
  expect(observed.callsWhileBlocked).toBe(1);
  const messages = observed.text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  expect(messages).toEqual([
    JSON.parse(observed.frame),
    { jsonrpc: "2.0", id: null, error: { _tag: "ParseError", code: -32700, message: "Parse error" } },
  ]);
  expect(expectMcpTransportFailure(observed.exit)?.message).toBe(
    "MCP stdio received a malformed JSON frame.",
  );
});

test("malformed input cannot overwrite the first blocked-writer failure", async () => {
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        // Given malformed input whose direct error writer waits behind a blocked RPC frame.
        const output = yield* controlledOutput();
        const writer = yield* output.write("blocked\n").pipe(Effect.forkScoped);
        yield* Deferred.await(output.started);
        const reader = yield* Stream.runDrain(output.guarded.stdio.stdin).pipe(Effect.forkScoped);
        yield* output.client.raw(new TextEncoder().encode("{bad}\n"));
        yield* Effect.yieldNow;
        // When the first writer fails at its deadline, closing admission.
        yield* TestClock.adjust("5 seconds");
        yield* Fiber.join(writer);
        yield* Fiber.join(reader);
        // Then the queued parse-error write never starts and timeout remains the first failure.
        return { calls: output.calls(), exit: yield* Effect.exit(Deferred.await(output.terminal)) };
      }),
    ).pipe(Effect.provide(TestClock.layer())),
  );
  expect(observed.calls).toBe(1);
  expect(expectMcpTransportFailure(observed.exit)?.message).toBe(
    "MCP stdio stdout write exceeded the 5 second deadline.",
  );
});
