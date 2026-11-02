import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { makeStdioClient } from "@lando/mcp/testing";
import { Deferred, Effect, Exit, Fiber, Layer, Stdio, Stream } from "effect";
import { forEach as forEachChunk } from "effect/Sink";
import { TestClock } from "effect/testing";
import { serverLayer } from "./server";

for (const shutdown of ["EOF", "interrupt"] as const) {
  for (const finish of ["complete", "deadline"] as const) {
    test(`public session retains admitted write through ${shutdown} until ${finish}`, async () => {
      const order: string[] = [];
      const chunks: string[] = [];
      const frames: string[] = [];
      let blocked = false;
      let calls = 0;
      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Given a public session with raw stdout blocked after a frame prefix.
            const client = yield* makeStdioClient();
            const started = yield* Deferred.make<void>();
            const release = yield* Deferred.make<void>();
            const inputClosed = yield* Deferred.make<void>();
            const stdio = Stdio.make({
              ...client.stdio,
              stdin: client.stdio.stdin.pipe(Stream.ensuring(Deferred.succeed(inputClosed, undefined))),
              stdout: () =>
                forEachChunk((chunk: string | Uint8Array) => {
                  const text = typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
                  if (!blocked) return Stream.run(Stream.make(text), client.stdio.stdout());
                  return Effect.gen(function* () {
                    calls++;
                    frames.push(text);
                    chunks.push(text.slice(0, 5));
                    yield* Deferred.succeed(started, undefined);
                    yield* Deferred.await(release);
                    chunks.push(text.slice(5));
                  }).pipe(
                    Effect.ensuring(
                      Effect.sync(() => {
                        order.push("write-cleanup");
                      }),
                    ),
                  );
                }),
            });
            const service = yield* McpService.pipe(
              Effect.provide(
                serverLayer({
                  runtimeLayer: Layer.effectDiscard(
                    Effect.addFinalizer(() =>
                      Effect.sync(() => {
                        order.push("runtime-finalizer");
                      }),
                    ),
                  ),
                }),
              ),
            );
            const fiber = yield* service
              .serve({ transport: "stdio" })
              .pipe(Effect.provideService(Stdio.Stdio, stdio), Effect.forkScoped);
            yield* client.initialize();
            blocked = true;
            yield* client.sendRequest("ping", {}, "admitted");
            yield* Deferred.await(started);
            yield* client.sendRequest("ping", {}, "queued");
            yield* TestClock.adjust("4 seconds");
            // When shutdown begins, the admitted write must keep its original deadline.
            const closing = yield* (shutdown === "EOF" ? client.close : Fiber.interrupt(fiber)).pipe(
              Effect.forkScoped,
            );
            if (shutdown === "EOF") yield* Deferred.await(inputClosed);
            else yield* TestClock.adjust("0 seconds");
            yield* Effect.yieldNow;
            expect(fiber.pollUnsafe()).toBeUndefined();
            expect(order).toEqual([]);
            expect(calls).toBe(1);
            if (finish === "complete") yield* Deferred.succeed(release, undefined);
            else yield* TestClock.adjust("1 second");
            yield* Fiber.join(closing);
            const exit = yield* Fiber.await(fiber);
            // Then raw IO finishes or cancels before the single runtime finalizer.
            return { exit, text: chunks.join(""), frame: frames.join("") };
          }),
        ).pipe(Effect.provide(TestClock.layer())),
      );
      expect(order).toEqual(["write-cleanup", "runtime-finalizer"]);
      expect(calls).toBe(1);
      expect(observed.text).toBe(finish === "complete" ? observed.frame : observed.frame.slice(0, 5));
      if (finish === "complete")
        expect(JSON.parse(observed.text)).toMatchObject({ id: "admitted", result: {} });
      expect(Exit.isSuccess(observed.exit)).toBe(shutdown === "EOF");
    });
  }
}
