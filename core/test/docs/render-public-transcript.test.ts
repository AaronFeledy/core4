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

  test("redacts machine-specific data in toPublicTranscriptView and rendered HTML (US-249)", () => {
    const leaking = Schema.decodeUnknownSync(PublicTranscript)({
      guideId: "redact-demo",
      scenarioId: "leak",
      variant: "",
      runtime: "cli",
      render: true,
      frames: [
        {
          kind: "run",
          sourceFile: "docs/guides/redact-demo.mdx",
          sourceLine: 12,
          commandDisplay: "lando start --root /home/aaron/lando --token s3cr3t123",
          resultSummary: "container aabbccddeeff on host devbox port :54321",
        },
        {
          kind: "inline",
          sourceFile: "docs/guides/redact-demo.mdx",
          sourceLine: 15,
          displayText: "code with secret bearer token and C:\\Users\\aaron\\AppData\\Local\\Temp\\lando-xyz",
        },
      ],
    });

    const view = toPublicTranscriptView(leaking, { redactionEnv: { host: "devbox" } });
    const html = renderPublicTranscriptHtml(leaking, { redactionEnv: { host: "devbox" } });

    expect(view.frames[0]?.commandDisplay).toContain("<HOME>");
    expect(view.frames[0]?.commandDisplay).toContain("[REDACTED]");
    expect(view.frames[0]?.resultSummary).toContain("<CONTAINER_ID>");
    expect(view.frames[0]?.resultSummary).toContain("<HOST>");
    expect(view.frames[0]?.resultSummary).toContain("<PORT>");
    expect(view.frames[1]?.displayText).toContain("[REDACTED]");
    expect(view.frames[1]?.displayText).toContain("<TMP>");

    expect(html).not.toContain("/home/aaron");
    expect(html).not.toContain("s3cr3t123");
    expect(html).not.toContain("aabbccddeeff");
    expect(html).not.toContain("devbox");
    expect(html).not.toContain(":54321");
    expect(html).not.toContain("C:\\Users\\aaron");

    expect(view.frames[0]?.sourceFile).toBe("docs/guides/redact-demo.mdx");
    expect(view.frames[0]?.sourceLine).toBe(12);
    expect(view.frames[0]?.kind).toBe("run");
    expect(html).toContain('data-source-file="docs/guides/redact-demo.mdx"');
    expect(html).toContain("#L12");
  });
});
