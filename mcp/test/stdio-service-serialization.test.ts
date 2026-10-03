import { expect, test } from "bun:test";
import { Effect, Schema } from "effect";
import { serverLayer, startServer, toolErrorObject } from "./server";

test("aggregate oversized result fails tagged, releases correlation, and preserves redaction", async () => {
  const secret = "known-service-secret";
  let calls = 0;
  const spec = {
    id: "app:info",
    summary: "Info",
    resultSchema: Schema.Struct({
      chunks: Schema.Array(Schema.Number),
      apiToken: Schema.String,
      note: Schema.String,
    }),
    run: () =>
      Effect.sync(() => ({
        chunks: ++calls === 1 ? Array.from({ length: 1_100_000 }, () => 1_000_000) : [1],
        apiToken: "secret-keyed-value",
        note: `note=${secret}`,
      })),
  };
  const responses = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        const first = yield* client.request("tools/call", { name: spec.id });
        const second = yield* client.request("tools/call", { name: spec.id });
        return [first, second] as const;
      }),
    ).pipe(
      Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }, [secret])),
    ),
  );
  expect(toolErrorObject(responses[0])).toMatchObject({
    _tag: "McpTransportError",
    message: "MCP command result exceeded the 8 MiB JSON serialization limit before schema encoding.",
  });
  expect(responses[1]).toMatchObject({
    result: { isError: false, structuredContent: { ok: true, result: { chunks: [1] } } },
  });
  const text = JSON.stringify(responses);
  expect(text).toContain("[redacted]");
  expect(text).not.toContain(secret);
  expect(text).not.toContain("secret-keyed-value");
});
