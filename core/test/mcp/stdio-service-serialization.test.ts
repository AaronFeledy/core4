import { describe, expect, test } from "bun:test";
import { Effect, Fiber, Layer, Queue, Schema } from "effect";

import type { McpCatalog } from "@lando/sdk/schema";
import { createRedactor } from "@lando/sdk/secrets";

import type { LandoCommandSpec } from "../../src/cli/oclif/command-base.ts";
import type { McpCommandEntry } from "../../src/mcp/registry.ts";
import {
  McpRuntimeConfig,
  type McpRuntimeConfigShape,
  McpService,
  McpServiceLive,
} from "../../src/mcp/service.ts";
import { makeStdioMcpTransport } from "../../src/mcp/stdio-transport.ts";
import { McpTransport } from "../../src/mcp/transport.ts";
import { RedactionService } from "../../src/redaction/service.ts";

const encoder = new TextEncoder();
const catalog = { tools: [] } satisfies McpCatalog;

const toolCallLine = (id: number): string =>
  JSON.stringify({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "app:info" } });

const parseObject = (text: string): Readonly<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("expected JSON object");
  }
  return parsed as Readonly<Record<string, unknown>>;
};

describe("MCP service stdio serialization", () => {
  test("aggregate oversized result fails tagged, releases correlation, and preserves redaction", async () => {
    // Given
    const secret = "known-service-secret";
    let calls = 0;
    const command: LandoCommandSpec = {
      id: "app:info",
      summary: "app:info summary",
      namespace: "app",
      bootstrap: "app",
      resultSchema: Schema.Struct({
        chunks: Schema.Array(Schema.Number),
        apiToken: Schema.String,
        note: Schema.String,
      }),
      run: () =>
        Effect.sync(() => {
          calls += 1;
          return {
            chunks: calls === 1 ? Array.from({ length: 1_100_000 }, () => 1_000_000) : [1],
            apiToken: "secret-keyed-value",
            note: `note=${secret}`,
          };
        }),
    };
    const config: McpRuntimeConfigShape = {
      commandEntries: [{ spec: command } satisfies McpCommandEntry],
      defaultAllowlist: ["app:info"],
      runtimeLayer: Layer.empty,
    };
    let inputController: ReadableStreamDefaultController<Uint8Array> | undefined;
    const input = new ReadableStream<Uint8Array>({
      start: (controller) => {
        inputController = controller;
      },
    });
    const serviceLayer = McpServiceLive.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.succeed(McpRuntimeConfig, config),
          Layer.succeed(RedactionService, {
            forProfile: () => Effect.succeed(createRedactor("secrets", { values: [secret] })),
          }),
        ),
      ),
    );

    // When
    const lines = await Effect.runPromise(
      Effect.gen(function* () {
        const output = yield* Queue.unbounded<string>();
        const transport = yield* makeStdioMcpTransport({
          catalog,
          input,
          write: (line) => Queue.offer(output, line).pipe(Effect.asVoid),
        });
        const service = yield* McpService;
        const fiber = yield* service
          .serve({ transport: "stdio" })
          .pipe(Effect.provideService(McpTransport, transport), Effect.forkScoped);
        if (inputController === undefined) return yield* Effect.die(new Error("input stream did not start"));
        inputController.enqueue(encoder.encode(`${toolCallLine(31)}\n`));
        const first = yield* Queue.take(output);
        inputController.enqueue(encoder.encode(`${toolCallLine(32)}\n`));
        const second = yield* Queue.take(output);
        inputController.close();
        yield* Fiber.join(fiber);
        return [first, second] as const;
      }).pipe(Effect.scoped, Effect.provide(serviceLayer)),
    );

    // Then
    const first = parseObject(lines[0]);
    const second = parseObject(lines[1]);
    expect(first).toMatchObject({
      id: 31,
      error: { code: -32603, data: { _tag: "McpTransportError" } },
    });
    expect(second).toMatchObject({ id: 32, result: expect.any(Object) });
    expect(lines.join("\n")).toContain("[redacted]");
    expect(lines.join("\n")).not.toContain(secret);
    expect(lines.join("\n")).not.toContain("secret-keyed-value");
  });
});
