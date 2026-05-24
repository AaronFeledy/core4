import { Transcript as CoreTranscript } from "@lando/core/schema";
import { Transcript } from "@lando/sdk/docs/components";
import { JSONSchema, ParseResult, Schema } from "effect";

const exampleTranscript = {
  guideId: "node-postgres",
  scenarioId: "reader-path",
  render: true,
  startedAt: "2026-05-23T12:00:00.000Z",
  finishedAt: "2026-05-23T12:00:01.000Z",
  durationMs: 1000,
  exitStatus: "pass",
  frames: [
    { kind: "run", command: ["version"], stdout: "0.0.0\n", stderr: "", exit: 0, durationMs: 3 },
    {
      kind: "verify",
      target: "event",
      matched: true,
      expected: "post-start",
      actual: { _tag: "post-start" },
    },
    { kind: "fixture", name: "invalid-service-type", copiedTo: "<testDir>/invalid-service-type" },
    { kind: "cleanup", command: ["destroy", "-y"], exit: 0 },
  ],
} as const;

describe("Transcript", () => {
  test("round-trips through SDK and core schema exports", () => {
    const decoded = Schema.decodeUnknownSync(Transcript)(exampleTranscript);

    expect(Schema.encodeSync(Transcript)(decoded)).toEqual(exampleTranscript);
    expect(Schema.decodeUnknownSync(CoreTranscript)(decoded)).toEqual(decoded);
    expect(JSONSchema.make(Transcript)).toMatchObject({
      $defs: { Transcript: { title: "Guide Scenario Transcript" } },
    });
  });

  test("rejects invalid timestamp and frame target values", () => {
    expect(() =>
      Schema.decodeUnknownSync(Transcript)({
        ...exampleTranscript,
        startedAt: "2026-05-23 12:00:00",
      }),
    ).toThrow(ParseResult.ParseError);

    expect(() =>
      Schema.decodeUnknownSync(Transcript)({
        ...exampleTranscript,
        frames: [{ kind: "verify", target: "command", matched: true, expected: "ok", actual: "ok" }],
      }),
    ).toThrow(ParseResult.ParseError);
  });
});
