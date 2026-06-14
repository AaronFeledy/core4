import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import {
  decodePublicTranscriptEither,
  renderPublicTranscriptHtml,
  toPublicTranscriptView,
} from "../../src/docs/render/index.ts";
import { PublicTranscript } from "../../src/schema/index.ts";

const phpTranscriptObject = {
  guideId: "php",
  scenarioId: "happy-path",
  variant: "",
  runtime: "cli",
  render: true,
  frames: [
    { kind: "step", sourceFile: "docs/guides/services/php.mdx", sourceLine: 10, displayText: "scaffold" },
    { kind: "step", sourceFile: "docs/guides/services/php.mdx", sourceLine: 18, displayText: "start" },
    {
      kind: "run",
      sourceFile: "docs/guides/services/php.mdx",
      sourceLine: 19,
      commandDisplay: "lando start",
      resultSummary: "expected exit 0",
    },
    {
      kind: "verify",
      sourceFile: "docs/guides/services/php.mdx",
      sourceLine: 20,
      resultSummary: 'event "post-start" observed',
    },
    { kind: "step", sourceFile: "docs/guides/services/php.mdx", sourceLine: 22, displayText: "cleanup" },
    { kind: "cleanup", sourceFile: "docs/guides/services/php.mdx", sourceLine: 23, displayText: "cleanup" },
    {
      kind: "run",
      sourceFile: "docs/guides/services/php.mdx",
      sourceLine: 24,
      commandDisplay: "lando destroy -y",
      resultSummary: "expected exit 0",
    },
  ],
};

const phpTranscript = Schema.decodeUnknownSync(PublicTranscript)(phpTranscriptObject);

describe("public transcript rendering", () => {
  test("renders transcript HTML with source links", () => {
    const html = renderPublicTranscriptHtml(phpTranscript);

    expect(html).toContain('data-guide-id="php"');
    expect(html).toContain('data-source-file="docs/guides/services/php.mdx"');
    expect(html).toContain("#L19");
    expect(html).toContain("lando start");
    expect(html).toContain("expected exit 0");
    expect(html).toContain('<a class="lando-frame__source" href="docs/guides/services/php.mdx#L19">');
  });

  test("renders source links with a base URL", () => {
    const html = renderPublicTranscriptHtml(phpTranscript, {
      sourceLinkBase: "https://github.com/x/y/blob/main",
    });

    expect(html).toContain('href="https://github.com/x/y/blob/main/docs/guides/services/php.mdx#L19"');
  });

  test("renders tab frames with variant display text", () => {
    const transcript = Schema.decodeUnknownSync(PublicTranscript)({
      guideId: "x",
      scenarioId: "happy-path",
      variant: "php=8.3",
      runtime: "cli",
      render: true,
      frames: [{ kind: "tab", sourceFile: "docs/guides/x.mdx", sourceLine: 5, displayText: "php=8.3" }],
    });

    const html = renderPublicTranscriptHtml(transcript);

    expect(html).toContain("lando-frame--tab");
    expect(html).toContain("php=8.3");
  });

  test("escapes interpolated HTML", () => {
    const transcript = Schema.decodeUnknownSync(PublicTranscript)({
      guideId: "escape",
      scenarioId: "happy-path",
      variant: "",
      runtime: "cli",
      render: true,
      frames: [
        {
          kind: "run",
          sourceFile: "docs/guides/escape.mdx",
          sourceLine: 7,
          commandDisplay: 'echo "<a>&b"',
        },
      ],
    });

    const html = renderPublicTranscriptHtml(transcript);

    expect(html).toContain("&lt;a&gt;&amp;b");
    expect(html).toContain("&quot;");
    expect(html).not.toContain('echo "<a>&b"');
  });

  test("decodes public transcript inputs", () => {
    expect(Either.isLeft(decodePublicTranscriptEither({}))).toBe(true);
    expect(Either.isRight(decodePublicTranscriptEither(phpTranscriptObject))).toBe(true);
  });

  test("maps view frames with source hrefs", () => {
    const view = toPublicTranscriptView(phpTranscript);

    expect(view.frames[2]?.sourceHref).toBe("docs/guides/services/php.mdx#L19");
    expect(view.frames[2]?.kind).toBe("run");
  });
});
