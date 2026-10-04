import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { serverLayer, startServer } from "./server";

test("completed request cancellation state remains harmless after 512 requests and id reuse", async () => {
  let calls = 0;
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        for (let id = 10; id < 522; id++) {
          yield* (yield* client.sendRequest("tools/call", { name: "app:info" }, id)).response;
        }
        yield* client.cancel(10);
        yield* client.request("ping");
        return yield* (yield* client.sendRequest("tools/call", { name: "app:info" }, 10)).response;
      }),
    ).pipe(
      Effect.provide(
        serverLayer({
          commandEntries: [
            {
              spec: {
                id: "app:info",
                summary: "Info",
                resultSchema: Schema.Struct({ calls: Schema.Number }),
                run: () => Effect.sync(() => ({ calls: ++calls })),
              },
            },
          ],
          defaultAllowlist: ["app:info"],
        }),
      ),
    ),
  );
  expect(calls).toBe(513);
  expect(observed).toMatchObject({
    id: 10,
    result: { isError: false, structuredContent: { result: { calls: 513 } } },
  });
});
