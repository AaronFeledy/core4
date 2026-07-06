import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";

import type { McpCatalog } from "@lando/sdk/schema";

import { makeStdioMcpTransport } from "../../src/mcp/stdio-transport.ts";

const encoder = new TextEncoder();

const catalog = {
  tools: [
    {
      toolId: "app:info",
      commandId: "app:info",
      title: "App info",
      description: "Show app information.",
      destructive: false,
      inputSchema: { type: "object" },
    },
  ],
} satisfies McpCatalog;

const inputFromMessages = (messages: ReadonlyArray<unknown>): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(
        encoder.encode(`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`),
      );
      controller.close();
    },
  });

const openInputFromMessage = (message: unknown): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(encoder.encode(`${JSON.stringify(message)}\n`));
    },
  });

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJsonObject = (line: string | undefined): Readonly<Record<string, unknown>> => {
  if (line === undefined) throw new Error("expected JSON-RPC line to be written");
  const parsed: unknown = JSON.parse(line);
  if (!isJsonObject(parsed)) throw new Error("expected JSON-RPC line to decode to an object");
  return parsed;
};

const findResponse = (
  messages: ReadonlyArray<Readonly<Record<string, unknown>>>,
  id: number,
): Readonly<Record<string, unknown>> => {
  const found = messages.find((message) => message.id === id);
  if (found === undefined) throw new Error(`expected response for id ${id}`);
  return found;
};

describe("makeStdioMcpTransport", () => {
  test("answers initialize and tools/list then closes on EOF", async () => {
    const writes: string[] = [];
    const input = inputFromMessages([
      { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
      { jsonrpc: "2.0", method: "notifications/initialized" },
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    ]);

    const received = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          serverInfo: { name: "lando-test", version: "4.0.0-test" },
          write: (line) =>
            Effect.sync(() => {
              writes.push(line);
            }),
        });
        while (writes.length < 2) yield* Effect.sleep("10 millis");
        return yield* transport.receive;
      }).pipe(Effect.scoped),
    );

    expect(Option.isNone(received)).toBe(true);
    const responses = writes.map(parseJsonObject);
    expect(findResponse(responses, 1)).toMatchObject({
      jsonrpc: "2.0",
      id: 1,
      result: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "lando-test", version: "4.0.0-test" },
      },
    });
    expect(findResponse(responses, 2)).toMatchObject({
      jsonrpc: "2.0",
      id: 2,
      result: { tools: [{ name: "app:info" }] },
    });
  });

  test("forwards tools/call requests and writes correlated tool results", async () => {
    const writes: string[] = [];
    const input = openInputFromMessage({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "app:info",
        arguments: {
          flags: { format: "json" },
          args: { service: "appserver" },
        },
      },
    });

    const received = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) =>
            Effect.sync(() => {
              writes.push(line);
            }),
        });
        const incoming = yield* transport.receive;
        if (Option.isSome(incoming)) {
          yield* transport.reply({
            id: incoming.value.id,
            ok: true,
            result: { envelope: { apiVersion: "v4", command: "app:info", ok: true }, ok: true },
          });
        }
        return incoming;
      }).pipe(Effect.scoped),
    );

    expect(Option.isSome(received)).toBe(true);
    if (Option.isSome(received)) {
      expect(received.value.request).toEqual({
        toolId: "app:info",
        input: { flags: { format: "json" }, args: { service: "appserver" } },
      });
    }
    expect(parseJsonObject(writes[0])).toMatchObject({
      jsonrpc: "2.0",
      id: 3,
      result: {
        content: [
          { type: "text", text: JSON.stringify({ apiVersion: "v4", command: "app:info", ok: true }) },
        ],
        isError: false,
      },
    });
  });
});
