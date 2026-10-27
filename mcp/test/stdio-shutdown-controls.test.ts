import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { Deferred, Effect, Fiber, Schema } from "effect";
import { serverLayer } from "./server";

for (const kind of ["tool", "resource"] as const) {
  for (const shutdown of ["EOF", "interrupt", "cancel"] as const) {
    test(`${kind} yielded cleanup emits no abandoned response on ${shutdown}`, async () => {
      let finalized = 0;
      const observed = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            // Given a request that remains active until interrupted, with yielding successful cleanup.
            const started = yield* Deferred.make<void>();
            const cleaned = yield* Deferred.make<void>();
            const work = Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.ensuring(
                Effect.yieldNow.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      finalized++;
                    }),
                  ),
                  Effect.andThen(Deferred.succeed(cleaned, undefined)),
                ),
              ),
            );
            const spec = {
              id: "app:exec",
              summary: "Block",
              resultSchema: Schema.Struct({}),
              run: () => work,
            };
            const service = yield* McpService.pipe(
              Effect.provide(
                serverLayer({
                  commandEntries: [{ spec }],
                  defaultAllowlist: [spec.id],
                  resources: [
                    {
                      uri: "lando://shutdown",
                      name: "Shutdown",
                      description: "Block",
                      resultSchema: Schema.Struct({}),
                      read: work,
                    },
                  ],
                }),
              ),
            );
            const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
            yield* client.sendRequest(
              kind === "tool" ? "tools/call" : "resources/read",
              kind === "tool" ? { name: spec.id } : { uri: "lando://shutdown" },
              "abandoned",
            );
            yield* Deferred.await(started);
            // When the transport closes or the request is explicitly cancelled.
            let ping: Schema.JsonObject | undefined;
            switch (shutdown) {
              case "EOF":
                yield* client.close;
                break;
              case "interrupt":
                yield* Fiber.interrupt(client.fiber);
                break;
              case "cancel":
                yield* client.cancel("abandoned");
                yield* Deferred.await(cleaned);
                ping = yield* client.request("ping");
                yield* client.close;
                break;
            }
            const exit = yield* Fiber.await(client.fiber);
            const messages = yield* client.messages;
            const fresh = yield* startStdioClient(service.serve({ transport: "stdio" }));
            const freshPing = yield* fresh.request("ping");
            yield* fresh.close;
            yield* Fiber.join(fresh.fiber);
            // Then cleanup completes without an abandoned reply, and later sessions remain usable.
            return { exit, messages, ping, freshPing };
          }),
        ),
      );
      expect(finalized).toBe(1);
      expect(observed.messages.filter((message) => message.id === "abandoned")).toEqual([]);
      expect(observed.exit._tag).toBe(shutdown === "interrupt" ? "Failure" : "Success");
      if (shutdown === "cancel") expect(observed.ping).toMatchObject({ result: {} });
      expect(observed.freshPing).toMatchObject({ result: {} });
    });
  }

  test(`genuine ${kind} failure retains its correlated error while the session is open`, async () => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          // Given a real handler failure, not transport abandonment.
          const spec = {
            id: "app:exec",
            summary: "Fail",
            resultSchema: Schema.Struct({}),
            run: () => Effect.die(new Error("tool defect")),
          };
          const service = yield* McpService.pipe(
            Effect.provide(
              serverLayer({
                commandEntries: [{ spec }],
                defaultAllowlist: [spec.id],
                resources: [
                  {
                    uri: "lando://failure",
                    name: "Failure",
                    description: "Fail",
                    resultSchema: Schema.Struct({}),
                    read: Effect.fail(new Error("resource failure")),
                  },
                ],
              }),
            ),
          );
          const client = yield* startStdioClient(service.serve({ transport: "stdio" }));
          // When the failing handler is called in an open session.
          const response = yield* client.request(
            kind === "tool" ? "tools/call" : "resources/read",
            kind === "tool" ? { name: spec.id } : { uri: "lando://failure" },
          );
          const ping = yield* client.request("ping");
          yield* client.close;
          yield* Fiber.join(client.fiber);
          // Then legitimate failure output is not suppressed or mistaken for shutdown.
          return { response, ping };
        }),
      ),
    );
    if (kind === "tool")
      expect(observed.response).toMatchObject({
        result: {
          isError: true,
          structuredContent: { ok: false, error: { _tag: "LandoInternalError", message: "tool defect" } },
        },
      });
    else expect(observed.response).toMatchObject({ error: { code: -32603, message: "resource failure" } });
    expect(observed.ping).toMatchObject({ result: {} });
  });
}
