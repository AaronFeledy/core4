import { expect, test } from "bun:test";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { resultObject, serverLayer, startServer } from "./server";

const encoder = new TextEncoder();
const malformed = '{"jsonrpc":"2.0","id":12,"method":"tools/list",}\n';
const parseError = { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } };

test("stdio keeps an in-flight tool running after a parse error", async () => {
  let finalized = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const spec = {
        id: "app:exec",
        summary: "Wait until released",
        resultSchema: Schema.Struct({}),
        run: () =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Deferred.await(release)),
            Effect.as({}),
            Effect.ensuring(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          ),
      };
      const client = yield* startServer().pipe(
        Effect.provide(
          serverLayer({
            commandEntries: [{ kind: "command", spec }],
            defaultAllowlist: [spec.id],
          }),
        ),
      );
      const call = yield* client.sendRequest("tools/call", { name: spec.id }, "running");
      yield* Deferred.await(started);
      yield* Effect.raceFirst(
        Effect.gen(function* () {
          yield* client.raw(encoder.encode(malformed));
          let message = yield* client.next;
          while (message.id !== null) message = yield* client.next;
          expect(message).toEqual(parseError);
          yield* Deferred.succeed(release, undefined);
          expect(resultObject(yield* call.response).structuredContent).toMatchObject({ ok: true });
        }),
        Fiber.join(client.fiber).pipe(Effect.andThen(Effect.never)),
      );
      yield* client.close;
      yield* Fiber.join(client.fiber);
    }).pipe(Effect.scoped, Effect.timeout("4 seconds")),
  );
  expect(finalized).toBe(1);
});
