import { expect, test } from "bun:test";
import { MAX_OUTBOUND_QUEUED_BYTES } from "@lando/mcp/stdio-limits";
import type { LandoEvent } from "@lando/sdk/services";
import { Effect, Layer, Schema } from "effect";
import { eventLayer, serverLayer, startServer, toolErrorObject } from "./server";

test("combined text and structured content respect the 8 MiB limit and publish failure", async () => {
  const events: LandoEvent[] = [];
  const spec = {
    id: "app:info",
    summary: "Info",
    resultSchema: Schema.Struct({ body: Schema.String }),
    run: () => Effect.succeed({ body: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES / 2) }),
  };
  const response = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return yield* client.request("tools/call", { name: spec.id });
      }),
    ).pipe(
      Effect.provide(
        serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }).pipe(
          Layer.provide(eventLayer(events)),
        ),
      ),
    ),
  );
  expect(toolErrorObject(response)).toMatchObject({
    _tag: "McpTransportError",
    message: "MCP tool result frame exceeded the 8 MiB JSON serialization limit.",
  });
  expect(events.filter((event) => event._tag === "pre-mcp-call")).toHaveLength(1);
  expect(events.filter((event) => event._tag === "post-mcp-call")).toEqual([
    expect.objectContaining({ outcome: "failure", failureDetail: "McpTransportError" }),
  ]);
});

test("oversized-result-fails-closed-before-retaining-the-complete-frame", async () => {
  let trailingPropertyRead = false;
  let calls = 0;
  const spec = {
    id: "app:info",
    summary: "Info",
    resultSchema: Schema.Unknown,
    run: () =>
      Effect.sync(() =>
        ++calls === 1
          ? {
              body: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1),
              get trailing() {
                trailingPropertyRead = true;
                return "must-not-be-read";
              },
            }
          : { body: "ok" },
      ),
  };
  const responses = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        return [
          yield* client.request("tools/call", { name: spec.id }),
          yield* client.request("tools/call", { name: spec.id }),
        ] as const;
      }),
    ).pipe(Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }))),
  );
  expect(trailingPropertyRead).toBe(false);
  expect(toolErrorObject(responses[0])).toMatchObject({
    _tag: "McpTransportError",
    message: expect.stringContaining("8 MiB"),
  });
  expect(responses[0]).toMatchObject({ result: { isError: true } });
  expect(responses[1]).toMatchObject({
    result: { isError: false, structuredContent: { result: { body: "ok" } } },
  });
});

test("oversized-progress-fails-before-reading-values-past-the-bound", async () => {
  let trailingPropertyRead = false;
  const spec = {
    id: "app:info",
    summary: "Info",
    resultSchema: Schema.Struct({}),
    run: () => Effect.succeed({}),
    streamFrames: () => [
      {
        _tag: "stdout" as const,
        chunk: "x".repeat(MAX_OUTBOUND_QUEUED_BYTES + 1),
        get trailing() {
          trailingPropertyRead = true;
          return "must-not-be-read";
        },
      },
    ],
  };
  const observed = await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const client = yield* startServer();
        const response = yield* client.request("tools/call", {
          name: spec.id,
          _meta: { progressToken: "oversized-progress" },
        });
        return { response, notifications: yield* client.notifications };
      }),
    ).pipe(Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }))),
  );
  expect(toolErrorObject(observed.response)).toMatchObject({
    _tag: "McpTransportError",
    message: expect.stringContaining("8 MiB"),
  });
  expect(trailingPropertyRead).toBe(false);
  expect(observed.notifications).toEqual([]);
});

test.each(["circular", "bigint"])(
  "non-serializable-progress-values fail tagged without notifications: %s",
  async (kind) => {
    const circular: { readonly _tag: "stdout"; chunk: unknown } = { _tag: "stdout", chunk: undefined };
    circular.chunk = circular;
    const frame = { _tag: "stdout" as const, chunk: "placeholder" };
    Object.defineProperty(frame, "chunk", { value: kind === "circular" ? circular : 1n });
    const spec = {
      id: "app:info",
      summary: "Info",
      resultSchema: Schema.Struct({}),
      run: () => Effect.succeed({}),
      streamFrames: () => [frame],
    };
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const client = yield* startServer();
          const response = yield* client.request("tools/call", {
            name: spec.id,
            _meta: { progressToken: kind },
          });
          return { response, notifications: yield* client.notifications };
        }),
      ).pipe(Effect.provide(serverLayer({ commandEntries: [{ spec }], defaultAllowlist: [spec.id] }))),
    );
    expect(toolErrorObject(observed.response)).toMatchObject({ _tag: "McpTransportError" });
    expect(observed.notifications).toEqual([]);
  },
);
