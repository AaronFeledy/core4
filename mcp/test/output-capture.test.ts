import { describe, expect, test } from "bun:test";
import { createRedactor } from "@lando/sdk/secrets";
import { DEFAULT_OUTPUT_BYTES, OutputCapture } from "../src/output-capture";

const redactor = createRedactor("secrets", { values: [] });
describe("bounded final output capture", () => {
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
    expect(Buffer.byteLength(encoded) + Buffer.byteLength(JSON.stringify(encoded))).toBeLessThan(
      DEFAULT_OUTPUT_BYTES + 128,
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
