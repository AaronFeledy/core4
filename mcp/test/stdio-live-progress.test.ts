import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { McpTransportError } from "@lando/sdk/errors";
import { Deferred, Effect, Fiber, Layer, Schema } from "effect";
import { serverLayer, startServer } from "./server";

const completions = [
  { name: "success", effect: Effect.succeed({ done: true }), isError: false },
  {
    name: "typed failure",
    effect: Effect.fail(new McpTransportError({ message: "command failed", remediation: "retry" })),
    isError: true,
  },
  { name: "defect", effect: Effect.die(new Error("command defect")), isError: true },
  { name: "encode fallback", effect: Effect.succeed({ done: "invalid" }), isError: true },
];

describe("stdio live byte progress", () => {
  for (const [completion, token] of completions.flatMap((completion) =>
    [false, true].map((token) => [completion, token] as const),
  )) {
    test(`drains producer-finalizer bytes before ${completion.name}, token=${token}, and serves a subsequent call`, async () => {
      // Given one redaction service shared by the session and retained command runtime.
      const redaction = makeRedactionService();
      const spec = {
        id: "app:exec",
        summary: "Byte progress",
        resultSchema: Schema.Struct({ done: Schema.Boolean }),
        run: () =>
          Effect.gen(function* () {
            const service = yield* RedactionService;
            expect(service).toBe(redaction);
            yield* service.registerValues(["registered-secret", "held final"]);
            const sink = yield* StreamFrameSink;
            yield* Effect.addFinalizer(() =>
              sink.emit({ _tag: "stdout", chunk: Buffer.from(" final"), kind: "bytes", source: "build" }),
            );
            yield* sink.emit({
              _tag: "stdout",
              chunk: new TextEncoder().encode("registered-"),
              kind: "bytes",
              source: "build",
            });
            yield* sink.emit({
              _tag: "stdout",
              chunk: Buffer.from("secret\nheld"),
              kind: "bytes",
              source: "build",
            });
            return yield* completion.effect;
          }),
      };
      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* startServer();
            // When real tools/call requests execute raw byte producers through stdio.
            const response = yield* client.request("tools/call", {
              name: spec.id,
              ...(token ? { _meta: { progressToken: "live" } } : {}),
            });
            const next = yield* client.request("tools/call", { name: "app:info" });
            yield* client.close;
            yield* Fiber.join(client.fiber);
            return {
              response,
              next,
              notifications: yield* client.notifications,
              messages: yield* client.messages,
            };
          }),
        ).pipe(
          Effect.provide(
            serverLayer(
              {
                commandEntries: [
                  { spec },
                  {
                    spec: {
                      id: "app:info",
                      summary: "Info",
                      resultSchema: Schema.Struct({ done: Schema.Boolean }),
                      run: () => Effect.succeed({ done: true }),
                    },
                  },
                ],
                defaultAllowlist: [spec.id, "app:info"],
                runtimeLayer: Layer.succeed(RedactionService, redaction),
              },
              [],
              redaction,
            ),
          ),
          Effect.timeout("5 seconds"),
        ),
      );
      // Then tails are masked, source survives, and the session remains usable.
      expect(observed.response).toMatchObject({ result: { isError: completion.isError } });
      expect(observed.response).toMatchObject({
        result: {
          structuredContent: {
            output: {
              chunks: [
                { _tag: "stdout", chunk: "[redacted]\n", source: "build" },
                { _tag: "stdout", chunk: "[redacted]", source: "build" },
              ],
              truncated: false,
            },
          },
        },
      });
      expect(observed.next).toMatchObject({
        result: {
          isError: false,
          structuredContent: { ok: true, result: { done: true }, output: { chunks: [], truncated: false } },
        },
      });
      expect(observed.notifications).toEqual(
        token
          ? [
              { frame: { _tag: "stdout", chunk: "[redacted]\n", source: "build" } },
              { frame: { _tag: "stdout", chunk: "[redacted]", source: "build" } },
            ]
          : [],
      );
      expect(JSON.stringify(observed.messages)).not.toContain("registered-secret");
      const replyIndex = observed.messages.findIndex((message) => message.id === observed.response.id);
      expect(
        observed.messages
          .slice(replyIndex + 1)
          .some((message) => message.method === "notifications/progress"),
      ).toBe(false);
    });
  }

  test("drains held and producer-finalizer bytes on cancellation without a tool reply", async () => {
    // Given a producer holding a partial output stream until interrupted.
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const started = yield* Deferred.make<void>();
          const drained = yield* Deferred.make<void>();
          const spec = {
            id: "app:exec",
            summary: "Cancel bytes",
            resultSchema: Schema.Struct({}),
            run: () =>
              Effect.gen(function* () {
                const sink = yield* StreamFrameSink;
                yield* Effect.addFinalizer(() =>
                  sink.emit({ _tag: "stdout", chunk: Buffer.from(" final"), kind: "bytes" }),
                );
                yield* sink.emit({ _tag: "stdout", chunk: Buffer.from("held"), kind: "bytes" });
                yield* Deferred.succeed(started, undefined);
                return yield* Effect.never;
              }),
          };
          const client = yield* startServer().pipe(
            Effect.provide(
              serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }, ["held final"]),
            ),
          );
          yield* client.sendRequest(
            "tools/call",
            { name: spec.id, _meta: { progressToken: "cancel" } },
            "cancel-call",
          );
          yield* Deferred.await(started);
          // When the client cancels and observes the final progress notification.
          yield* client.cancel("cancel-call");
          yield* Effect.gen(function* () {
            while (true) {
              const message = yield* client.next;
              if (message.method === "notifications/progress") {
                yield* Deferred.succeed(drained, undefined);
                break;
              }
            }
          });
          yield* Deferred.await(drained);
          yield* client.request("ping");
          yield* client.close;
          yield* Fiber.join(client.fiber);
          return { notifications: yield* client.notifications, messages: yield* client.messages };
        }),
      ).pipe(Effect.timeout("5 seconds")),
    );
    // Then the command-local scope drains exactly once without swallowing cancellation.
    expect(observed.notifications).toEqual([{ frame: { _tag: "stdout", chunk: "[redacted]" } }]);
    expect(observed.messages.filter((message) => message.id === "cancel-call")).toEqual([]);
  });
});
