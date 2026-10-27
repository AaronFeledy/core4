import { describe, expect, test } from "bun:test";
import { StreamFrameSink } from "@lando/engine/operations/stream-frame-sink";
import { RedactionService, makeRedactionService } from "@lando/redaction/service";
import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect, Fiber, Layer, Schema } from "effect";
import { DEFAULT_OUTPUT_BYTES, OutputCapture } from "../src/output-capture";
import { serverLayer, startServer } from "./server";

const redactor = createRedactor("secrets", { values: [] });
describe("bounded final output capture", () => {
  test.each(["registered", "result"] as const)(
    "omits lost profile context for a late %s secret on completed failure",
    async (source) => {
      // Given: profile redaction consumes only a credential prefix at a live piece boundary.
      const redaction = makeRedactionService();
      const secret = "late-credential-fragment-XYZ0987654321";
      const spec = {
        id: "app:exec",
        summary: "Late profile boundary",
        resultSchema: Schema.Struct({ exitCode: Schema.Number, detail: Schema.String }),
        completion: () => commandCompletionFromExitCode(7),
        ...(source === "result" ? { redactionTokens: () => [secret] } : {}),
        run: () =>
          Effect.gen(function* () {
            const sink = yield* StreamFrameSink;
            yield* sink.emit({
              kind: "bytes",
              _tag: "stdout",
              chunk: Buffer.from(`${"x".repeat(65_522)}password=${secret}\n`),
            });
            if (source === "registered") yield* (yield* RedactionService).registerValues([secret]);
            return { exitCode: 7, detail: secret };
          }),
      };
      // When: tools/call completes without a progress token, after late secret discovery.
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
          Effect.timeout("5 seconds"),
        ),
      );
      const response = Schema.decodeUnknownSync(
        Schema.Struct({
          result: Schema.Struct({
            content: Schema.Array(Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })),
            structuredContent: Schema.ObjectKeyword,
          }),
        }),
      )(reply).result;
      // Then: both wire copies retain the typed failure, but no credential suffix.
      const expected = {
        ok: false,
        result: { exitCode: 7, detail: "[redacted]" },
        error: { _tag: "LandoCommandError", exitCode: 7 },
        output: { truncated: true },
      };
      expect(reply).toMatchObject({ result: { isError: true } });
      expect(response.structuredContent).toMatchObject(expected);
      expect(response.content).toHaveLength(1);
      for (const content of response.content) expect(JSON.parse(content.text)).toMatchObject(expected);
      for (const copy of [JSON.stringify(response.structuredContent), JSON.stringify(response.content)]) {
        for (const fragment of [secret, "credential-fragment", "XYZ0987654321"])
          expect(copy.includes(fragment)).toBe(false);
      }
    },
  );
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
      capture.append({ _tag: "stdout", chunk: secret }, secret);
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
    capture.append({ _tag: "stdout", chunk: "late-", service: "app" }, "late-");
    capture.append({ _tag: "stderr", chunk: "unrelated" }, "unrelated");
    capture.append({ _tag: "stdout", chunk: "secret", service: "app" }, "secret");
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
    capture.append({ _tag: "stderr", chunk: "old" }, "old");
    capture.append(
      { _tag: "stdout", chunk: '😀"\\\n'.repeat(100_000), service: "app" },
      '😀"\\\n'.repeat(100_000),
    );
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
    capture.append({ _tag: "stdout", chunk: "x", source: "s".repeat(DEFAULT_OUTPUT_BYTES) }, "x");
    expect(capture.snapshot(redactor)).toEqual({ chunks: [], truncated: true });
  });
  test("reduces capture for a near-limit complete response without clipping typed data", () => {
    const capture = new OutputCapture();
    capture.append({ _tag: "stdout", chunk: "x".repeat(100_000) }, "x".repeat(100_000));
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
