import { expect, test } from "bun:test";
import { ConfigExpressionError } from "@lando/sdk/errors";
import { Effect, Schema } from "effect";
import { serverLayer, startServer, toolErrorObject } from "./server";

test("MCP command failures preserve and redact passthrough expression fields", async () => {
  const secret = "private-expression-token";
  const spec = {
    id: "app:info",
    summary: "Info",
    resultSchema: Schema.Unknown,
    run: () =>
      Effect.fail(
        new ConfigExpressionError({
          message: "Missing value",
          path: "services.appserver.environment.GREETING",
          expression: `hi-${secret}-{{ app.nope }}`,
          filePath: "/app/.lando.yml",
          remediation: "Fix expression",
        }),
      ),
  };
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return yield* client.request("tools/call", { name: spec.id });
      }),
    ).pipe(
      Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }, [secret])),
    ),
  );
  expect(response).toMatchObject({
    result: {
      isError: true,
      structuredContent: {
        ok: false,
        error: {
          _tag: "ConfigExpressionError",
          path: "services.appserver.environment.GREETING",
          expression: "hi-[redacted]-{{ app.nope }}",
          filePath: "/app/.lando.yml",
        },
      },
    },
  });
  expect(JSON.stringify(response)).not.toContain(secret);
});

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
