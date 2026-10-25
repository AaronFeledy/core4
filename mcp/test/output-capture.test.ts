import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Fiber, Layer, Schema } from "effect";
import { DEFAULT_OUTPUT_BYTES, OutputCapture } from "../src/output-capture";
import { serverLayer, startServer } from "./server";

const redactor = createRedactor("secrets", { values: [] });
describe("bounded final output capture", () => {
  test.each(["fragmented", "expanding"] as const)(
    "protects late registered %s values in final output",
    async (mode) => {
      // Given: session and producer share registrations learned only after output delivery.
      const redaction = makeRedactionService();
      const secret = mode === "fragmented" ? "late-secret" : "Q";
      const spec = {
        id: "app:exec",
        summary: "Late registration",
        resultSchema: Schema.ObjectKeyword,
        run: () =>
          Effect.gen(function* () {
            const sink = yield* StreamFrameSink;
            if (mode === "fragmented") {
              yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: `${"x".repeat(65_531)}late-` });
              yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: "secret\n" });
            } else {
              yield* sink.emit({ kind: "bytes", _tag: "stdout", chunk: `${"Q".repeat(20_000)}\n` });
            }
            yield* (yield* RedactionService).registerValues([secret]);
            return {};
          }),
      };
      // When: a client receives the final result without progress notifications.
      const reply = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const client = yield* startServer();
            const response = yield* client.request("tools/call", { name: spec.id });
            yield* client.close;
            yield* Fiber.join(client.fiber);
            return response;
          }),
        ).pipe(
          Effect.provide(
            serverLayer(
              {
                commandEntries: [{ spec }],
                defaultAllowlist: [spec.id],
                runtimeLayer: Layer.succeed(RedactionService, redaction),
              },
              [],
              redaction,
            ),
          ),
        ),
      );
      const decoded = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({
            structuredContent: Schema.Struct({
              output: Schema.Struct({
                chunks: Schema.Array(Schema.Struct({ chunk: Schema.String })),
                truncated: Schema.Boolean,
              }),
            }),
          }),
        }),
      )(reply).result.structuredContent.output;
      const text = decoded.chunks.map((frame) => frame.chunk).join("");
      // Then: matching spans retained fragments and the sanitized wire capture stays bounded.
      expect(text).not.toContain(secret);
      expect(text).toContain("[redacted]");
      expect(
        Buffer.byteLength(JSON.stringify(decoded)) +
          Buffer.byteLength(JSON.stringify(JSON.stringify(decoded))),
      ).toBeLessThanOrEqual(DEFAULT_OUTPUT_BYTES);
      expect(decoded.truncated).toBe(true);
    },
  );
  test.each(["registered", "result"] as const)(
    "does not expose a clipped suffix of a %s secret",
    (source) => {
      // Given: a late secret longer than the retained capture window.
      let values: readonly string[] = [];
      const capture = new OutputCapture(() => values);
      const secret = `private-${"s".repeat(80_000)}-end`;
      capture.append({ _tag: "stdout", chunk: secret });
      // When: the result identifies the secret after the prefix was evicted.
      if (source === "result") capture.redactValues([secret]);
      else values = [secret];
      const output = capture.snapshot(redactor);
      // Then: no retained credential fragment is returned as command evidence.
      expect(output.truncated).toBe(true);
      expect(
        output.chunks
          .map((frame) => frame.chunk)
          .join("")
          .includes("s".repeat(32)),
      ).toBe(false);
    },
  );

  test("re-redacts newly discovered values across retained chunk boundaries", () => {
    const capture = new OutputCapture();
    capture.append({ _tag: "stdout", chunk: "late-", service: "app" });
    capture.append({ _tag: "stderr", chunk: "unrelated" });
    capture.append({ _tag: "stdout", chunk: "secret", service: "app" });
    capture.redactValues(["late-secret"]);
    const output = capture.snapshot(redactor);
    expect(
      output.chunks
        .filter((frame) => frame._tag === "stdout")
        .map((frame) => frame.chunk)
        .join(""),
    ).toBe("[redacted]");
    expect(JSON.stringify(output)).not.toContain("secret");
  });
  test("evicts old channels and trims escaped Unicode text to its wire budget", () => {
    const capture = new OutputCapture();
    capture.append({ _tag: "stderr", chunk: "old" });
    capture.append({ _tag: "stdout", chunk: '😀"\\\n'.repeat(100_000), service: "app" });
    const output = capture.snapshot(redactor);
    const encoded = JSON.stringify(output);
    expect(output.truncated).toBe(true);
    expect(output.chunks).toHaveLength(1);
    expect(output.chunks[0]?.chunk).not.toContain("�");
    expect(Buffer.byteLength(encoded) + Buffer.byteLength(JSON.stringify(encoded))).toBeLessThanOrEqual(
      DEFAULT_OUTPUT_BYTES,
    );
  });
  test("omits identities whose metadata cannot fit rather than renaming them", () => {
    const capture = new OutputCapture();
    capture.append({ _tag: "stdout", chunk: "x", source: "s".repeat(DEFAULT_OUTPUT_BYTES) });
    expect(capture.snapshot(redactor)).toEqual({ chunks: [], truncated: true });
  });
  test("reduces capture for a near-limit complete response without clipping typed data", () => {
    const capture = new OutputCapture();
    capture.append({ _tag: "stdout", chunk: "x".repeat(100_000) });
    const result = { value: "r".repeat(3_650_000) };
    const envelope = capture.fitEnvelope({ ok: true, result }, redactor);
    const text = JSON.stringify(envelope);
    const response = {
      jsonrpc: "2.0",
      id: "i".repeat(1_000_000),
      result: { content: [{ type: "text", text }], structuredContent: envelope, isError: false },
    };
    expect(Buffer.byteLength(JSON.stringify(response))).toBeLessThan(8_388_608);
    expect(envelope).toMatchObject({ result });
  });
});
