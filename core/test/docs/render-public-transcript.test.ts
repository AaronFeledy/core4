import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Either, Schema } from "effect";

import {
  InvalidSourceFileError,
  InvalidSourceLinkBaseError,
  assertHttpsSourceLinkBase,
  assertRepositoryRelativeSourceFile,
  decodePublicTranscriptEither,
  frameSourceHref,
  loadPublicTranscript,
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
      variant: "php=v8-3",
      runtime: "cli",
      render: true,
      frames: [{ kind: "tab", sourceFile: "docs/guides/x.mdx", sourceLine: 5, displayText: "php=v8-3" }],
    });

    const html = renderPublicTranscriptHtml(transcript);

    expect(html).toContain("lando-frame--tab");
    expect(html).toContain("php=v8-3");
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

  test("sanitizes decoded public transcript artifacts at load time", async () => {
    const root = await mkdtemp(join(tmpdir(), "lando-public-transcript-load-"));
    try {
      const transcriptDir = join(root, "dist", "transcripts", "public", "guides", "redact-demo");
      await mkdir(transcriptDir, { recursive: true });
      await writeFile(
        join(transcriptDir, "leak.json"),
        JSON.stringify({
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
              commandDisplay: `lando start --root ${tmpdir()}/lando-load-test --token=\"quoted-token\"`,
            },
          ],
        }),
      );

      const loaded = await loadPublicTranscript({
        root,
        guideId: "redact-demo",
        scenarioId: "leak",
        variant: "",
      });

      const command = loaded.frames[0]?.commandDisplay ?? "";
      expect(command).toContain("<TMP>");
      expect(command).toContain("[redacted]");
      expect(command).not.toContain(tmpdir());
      expect(command).not.toContain("quoted-token");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("maps view frames with source hrefs", () => {
    const view = toPublicTranscriptView(phpTranscript);

    expect(view.frames[2]?.sourceHref).toBe("docs/guides/services/php.mdx#L19");
    expect(view.frames[2]?.kind).toBe("run");
  });

  test("hard-fails non-https sourceLinkBase protocols", () => {
    // Given: a valid frame and unsafe non-https bases.
    const frame = phpTranscript.frames[2];
    if (frame === undefined) throw new Error("expected php transcript run frame");
    const cases = [
      "javascript:alert(1)",
      "data:text/html,hi",
      "http://github.com/x/y/blob/main",
      "//github.com/x/y/blob/main",
      "vbscript:msgbox(1)",
    ] as const;

    // When/Then: each base is rejected with the tagged source-link error.
    for (const sourceLinkBase of cases) {
      expect(() => frameSourceHref(frame, { sourceLinkBase })).toThrow(InvalidSourceLinkBaseError);
      expect(() => assertHttpsSourceLinkBase(sourceLinkBase)).toThrow(InvalidSourceLinkBaseError);
    }
  });

  test("accepts an exact https sourceLinkBase", () => {
    // Given: a lowercase https repository blob base.
    const base = "https://github.com/x/y/blob/main/";
    const frame = phpTranscript.frames[2];
    if (frame === undefined) throw new Error("expected php transcript run frame");

    // When: the base is normalized and a frame href is built.
    expect(assertHttpsSourceLinkBase(base)).toBe("https://github.com/x/y/blob/main");
    expect(frameSourceHref(frame, { sourceLinkBase: base })).toBe(
      "https://github.com/x/y/blob/main/docs/guides/services/php.mdx#L19",
    );
  });

  test("accepts mixed-case https sourceLinkBase after URL normalization", () => {
    // Given: mixed-case HTTPS schemes that WHATWG URL normalizes to https:.
    const frame = phpTranscript.frames[2];
    if (frame === undefined) throw new Error("expected php transcript run frame");
    const cases = [
      "HTTPS://github.com/x/y/blob/main",
      "Https://github.com/x/y/blob/main",
      "hTtPs://github.com/x/y/blob/main/",
    ] as const;

    // When/Then: each base normalizes to lowercase https without a trailing slash.
    for (const sourceLinkBase of cases) {
      expect(assertHttpsSourceLinkBase(sourceLinkBase)).toBe("https://github.com/x/y/blob/main");
      expect(frameSourceHref(frame, { sourceLinkBase })).toBe(
        "https://github.com/x/y/blob/main/docs/guides/services/php.mdx#L19",
      );
    }
  });

  test("hard-fails non-repository-relative sourceFile values", () => {
    // Given: path shapes that are absolute, traversable, schemed, or control-bearing.
    const cases = [
      "/etc/passwd",
      "\\\\server\\share",
      "docs/guides/../../../etc/passwd",
      "docs\\guides\\demo.mdx",
      "C:\\Users\\a\\demo.mdx",
      "javascript:alert(1)",
      "docs/guides/demo.mdx?raw=1",
      "docs/guides/demo.mdx#L1",
      "docs/guides/demo.mdx\0",
      "",
      "docs//guides/demo.mdx",
    ] as const;

    // When/Then: each sourceFile is rejected with the tagged source-file error.
    for (const sourceFile of cases) {
      expect(() => assertRepositoryRelativeSourceFile(sourceFile)).toThrow(InvalidSourceFileError);
      expect(() =>
        frameSourceHref(
          { kind: "run", sourceFile, sourceLine: 11 },
          { sourceLinkBase: "https://github.com/x/y/blob/main" },
        ),
      ).toThrow(InvalidSourceFileError);
    }
  });

  test("keeps valid repository-relative source files", () => {
    // Given: the default authored guide path shape.
    const sourceFile = "docs/guides/services/php.mdx";

    // When/Then: validation is a pure identity for legal paths.
    expect(assertRepositoryRelativeSourceFile(sourceFile)).toBe(sourceFile);
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
    expect(view.frames[0]?.commandDisplay).toContain("[redacted]");
    expect(view.frames[0]?.resultSummary).toContain("<CONTAINER_ID>");
    expect(view.frames[0]?.resultSummary).toContain("<HOST>");
    expect(view.frames[0]?.resultSummary).toContain("<PORT>");
    expect(view.frames[1]?.displayText).toContain("[redacted]");
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
