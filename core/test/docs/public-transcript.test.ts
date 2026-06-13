import { PublicTranscript as CorePublicTranscript } from "@lando/core/schema";
import { PublicTranscript } from "@lando/sdk/docs/components";
import { JSONSchema, ParseResult, Schema } from "effect";

const examplePublicTranscript = {
  guideId: "node-postgres",
  scenarioId: "reader-path",
  variant: "runtime=php8.3",
  runtime: "cli",
  render: true,
  frames: [
    {
      kind: "tab",
      sourceFile: "docs/guides/recipes/example.mdx",
      sourceLine: 9,
      displayText: "runtime=php8.3",
    },
    { kind: "step", sourceFile: "docs/guides/recipes/example.mdx", sourceLine: 10, displayText: "start" },
    {
      kind: "run",
      sourceFile: "docs/guides/recipes/example.mdx",
      sourceLine: 11,
      commandDisplay: "lando start",
      resultSummary: "expected exit 0",
    },
    {
      kind: "verify",
      sourceFile: "docs/guides/recipes/example.mdx",
      sourceLine: 12,
      resultSummary: 'event "post-start" observed',
    },
    {
      kind: "inspect",
      sourceFile: "docs/guides/recipes/example.mdx",
      sourceLine: 13,
      displayText: "inspect output",
    },
    {
      kind: "inline",
      sourceFile: "docs/guides/recipes/example.mdx",
      sourceLine: 14,
      displayText: "inline yaml",
      commandDisplay: "name: app\n",
    },
    {
      kind: "cleanup",
      sourceFile: "docs/guides/recipes/example.mdx",
      sourceLine: 15,
      displayText: "cleanup",
    },
  ],
} as const;

describe("PublicTranscript", () => {
  test("round-trips through SDK and core schema exports", () => {
    const decoded = Schema.decodeUnknownSync(PublicTranscript)(examplePublicTranscript);

    expect(Schema.encodeSync(PublicTranscript)(decoded)).toEqual(examplePublicTranscript);
    expect(Schema.decodeUnknownSync(CorePublicTranscript)(decoded)).toEqual(decoded);
    expect(JSONSchema.make(PublicTranscript)).toMatchObject({
      $defs: { PublicTranscript: { title: "Public Guide Scenario Transcript" } },
    });
  });

  test("rejects unknown frame kinds and non-positive source lines", () => {
    expect(() =>
      Schema.decodeUnknownSync(PublicTranscript)({
        ...examplePublicTranscript,
        frames: [{ kind: "hidden", sourceFile: "docs/guides/x.mdx", sourceLine: 1 }],
      }),
    ).toThrow(ParseResult.ParseError);

    expect(() =>
      Schema.decodeUnknownSync(PublicTranscript)({
        ...examplePublicTranscript,
        frames: [{ kind: "step", sourceFile: "docs/guides/x.mdx", sourceLine: 0 }],
      }),
    ).toThrow(ParseResult.ParseError);
  });
});
