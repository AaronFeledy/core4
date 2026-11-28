import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import type { McpTransportError } from "@lando/sdk/errors";
import { Deferred, Effect, Fiber, PlatformError, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { TestClock } from "effect/testing";
import { guardStdio } from "../src/stdio-guard";
import { makeStdioClient } from "../src/testing";
import { serverLayer } from "./server";
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

test.each([
  { count: 1, outcome: "release" },
  { count: 20, outcome: "release" },
  { count: 1, outcome: "deadline" },
  { count: 20, outcome: "deadline" },
  { count: 1, outcome: "EOF" },
] as const)(
  "stdio handles $count malformed lines behind a held write on $outcome",
  async ({ count, outcome }) => {
    const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };
    const admitted = { jsonrpc: "2.0", id: "admitted", result: {} };
    await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const started = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const inputClosed = yield* Deferred.make<void>();
        let observeWrites = false;
        let calls = 0;
        const stdio = Stdio.make({
          ...client.stdio,
          stdin: client.stdio.stdin.pipe(Stream.ensuring(Deferred.succeed(inputClosed, undefined))),
          stdout: () =>
            forEachChunk((chunk: string | Uint8Array) => {
              const write = (part: string | Uint8Array) =>
                Stream.run(Stream.make(part), client.stdio.stdout());
              if (!observeWrites || ++calls > 1) return write(chunk);
              const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
              return write(text.slice(0, 5)).pipe(
                Effect.andThen(Deferred.succeed(started, undefined)),
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(write(text.slice(5))),
              );
            }),
        });
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(Stdio.Stdio, stdio), Effect.forkScoped);
        yield* client.initialize();
        observeWrites = true;
        const ping = yield* client.sendRequest("ping", {}, "admitted");
        yield* Deferred.await(started);
        yield* client.raw(new TextEncoder().encode("{bad}\n".repeat(count)));
        yield* TestClock.adjust("0 millis");
        expect(calls).toBe(1);
        switch (outcome) {
          case "release":
            yield* Deferred.succeed(release, undefined);
            yield* Effect.raceFirst(
              Effect.gen(function* () {
                expect(yield* ping.response).toEqual(admitted);
                let errors = 0;
                while (errors < count) if ((yield* client.next).id === null) errors++;
                expect((yield* client.request("ping")).result).toEqual({});
              }),
              Fiber.join(fiber).pipe(Effect.andThen(Effect.never)),
            );
            yield* client.close;
            yield* Fiber.join(fiber);
            expect(
              (yield* client.messages).filter((message) => message.id === "admitted" || message.id === null),
            ).toEqual([admitted, ...Array.from({ length: count }, () => parseError)]);
            break;
          case "deadline":
            yield* TestClock.adjust("5 seconds");
            expect(expectMcpTransportFailure(yield* Fiber.await(fiber))?.message).toBe(
              "MCP stdio stdout write exceeded the 5 second deadline.",
            );
            expect(calls).toBe(1);
            expect((yield* client.messages).map((message) => message.id)).toEqual([1]);
            break;
          case "EOF":
            yield* client.close;
            yield* Deferred.await(inputClosed);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(fiber);
            expect(calls).toBe(1);
            expect((yield* client.messages).slice(1)).toEqual([admitted]);
            break;
          default:
            outcome satisfies never;
        }
      }).pipe(Effect.scoped, Effect.provide(serverLayer()), Effect.provide(TestClock.layer())),
    );
  },
);

test.each(["stdin", "stdout"] as const)(
  "stdio ends on a typed %s failure without retrying",
  async (channel) => {
    let attempts = 0;
    const fault = PlatformError.systemError({ _tag: "Unknown", module: "Stdio", method: channel });
    const fail = Effect.suspend(() => {
      attempts++;
      return Effect.fail(fault);
    });
    const exit = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* makeStdioClient();
        const service = yield* McpService;
        const stdio = Stdio.make({
          ...client.stdio,
          stdin: channel === "stdin" ? Stream.fromEffect(fail) : client.stdio.stdin,
          stdout: channel === "stdout" ? () => forEachChunk(() => fail) : client.stdio.stdout,
        });
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(Stdio.Stdio, stdio), Effect.forkScoped);
        if (channel === "stdout") yield* client.sendRequest("ping");
        return yield* Fiber.await(fiber);
      }).pipe(Effect.scoped, Effect.provide(serverLayer()), Effect.timeout("4 seconds")),
    );
    expect(expectMcpTransportFailure(exit)?.message).toBe(
      channel === "stdin" ? "MCP stdio input failed while reading a frame." : fault.message,
    );
    expect(attempts).toBe(1);
  },
);
