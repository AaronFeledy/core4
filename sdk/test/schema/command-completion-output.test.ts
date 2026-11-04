import { describe, expect, test } from "bun:test";
import { CommandCompletion, CommandOutput, CommandOutputChunk } from "@lando/sdk/schema";
import { Schema } from "effect";

describe("command completion and output wire contracts", () => {
  test.each([
    { ok: true, exitCode: 0 },
    { ok: true, exitCode: 1 },
    { ok: false, exitCode: 700 },
  ])("accepts explicit completion %j", (value) => {
    expect(Schema.decodeUnknownSync(CommandCompletion)(value)).toEqual(value);
  });
  test.each([
    { ok: false, exitCode: 0 },
    { ok: true, exitCode: -1 },
    { ok: false, exitCode: 0.5 },
    { exitCode: 7 },
    { ok: true },
  ])("rejects invalid completion %j", (value) => {
    expect(() => Schema.decodeUnknownSync(CommandCompletion)(value)).toThrow();
  });
  test("round-trips output provenance and the truncated flag", () => {
    const chunk = Schema.decodeUnknownSync(CommandOutputChunk)({
      _tag: "stderr",
      chunk: "line\n",
      service: "app",
      source: "build",
    });
    const output = { chunks: [chunk], truncated: true };
    const encoded = Schema.encodeSync(CommandOutput)(output);
    expect(Schema.decodeUnknownSync(CommandOutput)(encoded)).toEqual(output);
  });
});
