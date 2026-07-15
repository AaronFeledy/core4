import { describe, expect, test } from "bun:test";
import { Effect, Option } from "effect";

import type { McpCatalog } from "@lando/sdk/schema";

import { MAX_OUTBOUND_QUEUED_BYTES } from "../../src/mcp/stdio-limits.ts";
import { makeStdioMcpTransport } from "../../src/mcp/stdio-transport.ts";
import { expectPolledMcpTransportFailure } from "./stdio-transport-test-support.ts";

const encoder = new TextEncoder();
const catalog = { tools: [] } satisfies McpCatalog;

const isJsonObject = (value: unknown): value is Readonly<Record<string, unknown>> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const parseJsonObject = (line: string): Readonly<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(line);
  if (!isJsonObject(parsed)) throw new Error("expected JSON-RPC line to decode to an object");
  return parsed;
};

const openToolCallsInput = (
  calls: ReadonlyArray<{ readonly id: number; readonly progressToken?: string }>,
): ReadableStream<Uint8Array> =>
  new ReadableStream<Uint8Array>({
    start: (controller) => {
      controller.enqueue(
        encoder.encode(
          `${calls
            .map(({ id, progressToken }) =>
              JSON.stringify({
                jsonrpc: "2.0",
                id,
                method: "tools/call",
                params: {
                  name: "app:info",
                  ...(progressToken === undefined ? {} : { _meta: { progressToken } }),
                },
              }),
            )
            .join("\n")}\n`,
        ),
      );
    },
  });

describe("MCP stdio serialization bounds", () => {
  test("oversized-result-fails-closed-before-retaining-the-complete-frame", async () => {
    // Given
    const writes: string[] = [];
    let trailingPropertyRead = false;
    const input = openToolCallsInput([{ id: 18 }, { id: 19 }]);

    // When
    await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) => Effect.sync(() => writes.push(line)),
        });
        const oversized = yield* transport.receive;
        if (Option.isNone(oversized)) return yield* Effect.die(new Error("expected oversized request"));
        yield* transport.reply({
          id: oversized.value.id,
          ok: true,
          result: {
            envelope: {
              apiVersion: "v4",
              command: "app:info",
              ok: true,
              result: {
                body: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1),
                get trailing(): string {
                  trailingPropertyRead = true;
                  return "must-not-be-read";
                },
              },
            },
            ok: true,
          },
        });

        const valid = yield* transport.receive;
        if (Option.isNone(valid)) return yield* Effect.die(new Error("expected follow-up request"));
        yield* transport.reply({
          id: valid.value.id,
          ok: true,
          result: { envelope: { apiVersion: "v4", command: "app:info", ok: true }, ok: true },
        });
      }).pipe(Effect.scoped),
    );

    // Then
    expect(trailingPropertyRead).toBe(false);
    expect(writes.map(parseJsonObject)).toEqual([
      expect.objectContaining({
        id: 18,
        error: expect.objectContaining({
          code: -32603,
          data: expect.objectContaining({ _tag: "McpTransportError" }),
        }),
      }),
      expect.objectContaining({ id: 19, result: expect.any(Object) }),
    ]);
  });

  test("oversized-progress-fails-before-reading-values-past-the-bound", async () => {
    // Given
    const writes: string[] = [];
    let trailingPropertyRead = false;
    const input = openToolCallsInput([{ id: 20, progressToken: "oversized-progress" }]);

    // When
    const completion = await Effect.runPromise(
      Effect.gen(function* () {
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) => Effect.sync(() => writes.push(line)),
        });
        const incoming = yield* transport.receive;
        if (Option.isNone(incoming)) return Option.none();
        return yield* transport
          .notify({
            id: incoming.value.id,
            frame: {
              body: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1),
              get trailing(): string {
                trailingPropertyRead = true;
                return "must-not-be-read";
              },
            },
          })
          .pipe(Effect.exit, Effect.map(Option.some));
      }).pipe(Effect.scoped),
    );

    // Then
    const error = expectPolledMcpTransportFailure(completion);
    expect(error?.message).toContain("8 MiB");
    expect(trailingPropertyRead).toBe(false);
    expect(writes).toEqual([]);
  });

  test("non-serializable-progress-values-fail-with-a-tagged-transport-error", async () => {
    // Given
    const circular: { self?: unknown } = {};
    circular.self = circular;
    const cases: ReadonlyArray<{ readonly id: number; readonly frame: unknown }> = [
      { id: 21, frame: circular },
      { id: 22, frame: { value: 1n } },
    ];

    for (const { id, frame } of cases) {
      const writes: string[] = [];

      // When
      const completion = await Effect.runPromise(
        Effect.gen(function* () {
          const transport = yield* makeStdioMcpTransport({
            catalog,
            input: openToolCallsInput([{ id, progressToken: `progress-${id}` }]),
            write: (line) => Effect.sync(() => writes.push(line)),
          });
          const incoming = yield* transport.receive;
          if (Option.isNone(incoming)) return Option.none();
          return yield* transport
            .notify({ id: incoming.value.id, frame })
            .pipe(Effect.exit, Effect.map(Option.some));
        }).pipe(Effect.scoped),
      );

      // Then
      expectPolledMcpTransportFailure(completion);
      expect(writes).toEqual([]);
    }
  });
});
