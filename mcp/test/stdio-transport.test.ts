import { expect, test } from "bun:test";
import { McpService } from "@lando/mcp/service";
import { startStdioClient } from "@lando/mcp/testing";
import { Effect, Fiber, Schema } from "effect";
import { resultObject, serverLayer, startServer } from "./server";

const spec = {
  id: "app:info",
  summary: "App info",
  description: "Show app information.",
  flags: { format: { type: "string" } },
  args: { service: { type: "string" } },
  resultSchema: Schema.Struct({ service: Schema.String }),
  run: (input: { readonly args: Record<string, unknown> }) =>
    Effect.succeed({ service: input.args.service ?? "appserver" }),
};
const layer = serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id], version: "4.0.0-test" });

test.each(["2025-06-18", "2025-03-26", "2024-11-05"])(
  "negotiates %s, lists tools with outputSchema, and closes on EOF",
  async (protocol) => {
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const service = yield* McpService;
          const { makeStdioClient } = yield* Effect.promise(() => import("@lando/mcp/testing"));
          const client = yield* makeStdioClient();
          const fiber = yield* service
            .serve({ transport: "stdio" })
            .pipe(Effect.provide(client.layer), Effect.forkScoped);
          const initialize = yield* client.initialize({}, protocol);
          const tools = yield* client.request("tools/list");
          yield* client.close;
          const exit = yield* Fiber.await(fiber);
          return { initialize, tools, exit };
        }),
      ).pipe(Effect.provide(layer)),
    );
    expect(observed.initialize).toMatchObject({
      jsonrpc: "2.0",
      result: {
        protocolVersion: protocol,
        capabilities: { tools: {} },
        serverInfo: { name: "lando", version: "4.0.0-test" },
      },
    });
    expect(observed.tools).toMatchObject({
      result: {
        tools: [
          {
            name: "app:info",
            inputSchema: { type: "object" },
            ...(protocol === "2025-06-18" ? { outputSchema: { type: "object" } } : {}),
          },
        ],
      },
    });
    expect(observed.exit._tag).toBe("Success");
  },
);

test("forwards tools/call arguments and writes correlated text and structured envelopes", async () => {
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return yield* client.request("tools/call", {
          name: spec.id,
          arguments: { flags: { format: "json" }, args: { service: "appserver" } },
        });
      }),
    ).pipe(Effect.provide(layer)),
  );
  const result = resultObject(response);
  expect(result).toMatchObject({
    isError: false,
    structuredContent: { apiVersion: "v4", command: "app:info", ok: true, result: { service: "appserver" } },
  });
  const text = Schema.decodeUnknownSync(
    Schema.Struct({
      content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
    }),
  )(result).content[0]?.text;
  expect(JSON.parse(text ?? "null")).toEqual(result.structuredContent);
});

test("writes MCP-shaped progress notifications with increasing tokens and skips absent tokens", async () => {
  const streaming = {
    ...spec,
    streamFrames: () => [
      { _tag: "stdout" as const, chunk: "Starting" },
      { _tag: "stderr" as const, chunk: "Waiting" },
    ],
  };
  const messages = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        yield* client.request("tools/call", { name: spec.id, _meta: { progressToken: "progress-1" } });
        yield* client.request("tools/call", { name: spec.id });
        return yield* client.messages;
      }),
    ).pipe(
      Effect.provide(serverLayer({ commandEntries: [{ spec: streaming }], defaultAllowlist: [spec.id] })),
    ),
  );
  expect(messages.filter((message) => message.method === "notifications/progress")).toEqual([
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "progress-1", progress: 1, message: '{"_tag":"stdout","chunk":"Starting"}' },
    },
    {
      jsonrpc: "2.0",
      method: "notifications/progress",
      params: { progressToken: "progress-1", progress: 2, message: '{"_tag":"stderr","chunk":"Waiting"}' },
    },
  ]);
});

test("denied tools are absent from tools/list and rejected as unknown without execution", async () => {
  let executed = false;
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* McpService;
        const client = yield* startStdioClient(service.serve({ transport: "stdio", deny: [spec.id] }));
        const list = yield* client.request("tools/list");
        const rejected = yield* client.request("tools/call", { name: spec.id });
        return { list, rejected };
      }),
    ).pipe(
      Effect.provide(
        serverLayer({
          commandEntries: [
            {
              spec: {
                ...spec,
                run: () =>
                  Effect.sync(() => {
                    executed = true;
                    return { service: "appserver" };
                  }),
              },
            },
          ],
          defaultAllowlist: [spec.id],
        }),
      ),
    ),
  );
  expect(response.list).toMatchObject({ result: { tools: [] } });
  expect(response.rejected).toMatchObject({ error: { code: -32602, message: "Tool 'app:info' not found" } });
  expect(executed).toBe(false);
});

test("undecodable tools/call parameters stay protocol errors", async () => {
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return yield* client.request("tools/call", { arguments: {} });
      }),
    ).pipe(Effect.provide(layer)),
  );
  expect(response).toMatchObject({ error: { code: -32602 } });
});
