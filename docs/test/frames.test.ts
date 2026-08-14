import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { InvalidSourceLinkBaseError } from "@lando/core/docs/render";

import {
  DEFAULT_SOURCE_LINK_BASE,
  frameKeyFor,
  resolveComponentFrame,
  transcriptRequestFor,
} from "../src/lib/frames.ts";

const TRANSCRIPT_ROOT = resolve(import.meta.dir, "fixtures", "transcripts");

const CAPTURED_PROPS = {
  "data-guide-id": "demo",
  "data-scenario-id": "happy-path",
  "data-source-file": "docs/guides/demo.mdx",
  "data-source-line": "11",
} as const;

const previousRoot = process.env.LANDO_DOCS_TRANSCRIPT_ROOT;
const previousBase = process.env.LANDO_DOCS_SOURCE_LINK_BASE;

afterEach(() => {
  process.env.LANDO_DOCS_TRANSCRIPT_ROOT = previousRoot ?? "";
  process.env.LANDO_DOCS_SOURCE_LINK_BASE = previousBase ?? "";
});

describe("docs component frame resolution", () => {
  test("links a captured frame to the repository source base", async () => {
    // Given: a fixture transcript and an explicit repository blob base.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;
    process.env.LANDO_DOCS_SOURCE_LINK_BASE = "https://github.com/x/y/blob/main";

    // When: a Run component resolves its captured frame.
    const resolution = await resolveComponentFrame(CAPTURED_PROPS, "run", "lando start");

    // Then: the source href is absolute and points at the authored guide line.
    expect(resolution.status).toBe("captured");
    if (resolution.status !== "captured") throw new Error("expected a captured frame");
    expect(resolution.frame.sourceHref).toBe("https://github.com/x/y/blob/main/docs/guides/demo.mdx#L11");
  });

  test("defaults captured frames to the Lando repository blob base", async () => {
    // Given: a fixture transcript and no source-link override.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;
    process.env.LANDO_DOCS_SOURCE_LINK_BASE = "";

    // When: a Run component resolves its captured frame.
    const resolution = await resolveComponentFrame(CAPTURED_PROPS, "run", "lando start");

    // Then: the default repository blob URL is used.
    expect(resolution.status).toBe("captured");
    if (resolution.status !== "captured") throw new Error("expected a captured frame");
    expect(resolution.frame.sourceHref).toBe(`${DEFAULT_SOURCE_LINK_BASE}/docs/guides/demo.mdx#L11`);
  });

  test("hard-fails non-https LANDO_DOCS_SOURCE_LINK_BASE overrides", async () => {
    // Given: a fixture transcript and an unsafe source-link override.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;
    const cases = [
      "javascript:alert(1)",
      "data:text/html,hi",
      "http://github.com/x/y/blob/main",
      "//github.com/x/y/blob/main",
      "vbscript:msgbox(1)",
    ] as const;

    // When/Then: resolving a frame rejects the override before rendering.
    for (const sourceLinkBase of cases) {
      process.env.LANDO_DOCS_SOURCE_LINK_BASE = sourceLinkBase;
      let thrown: unknown;
      try {
        await resolveComponentFrame(CAPTURED_PROPS, "run");
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InvalidSourceLinkBaseError);
    }
  });

  test("accepts mixed-case https LANDO_DOCS_SOURCE_LINK_BASE overrides", async () => {
    // Given: a fixture transcript and mixed-case HTTPS overrides.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;
    const cases = [
      "HTTPS://github.com/x/y/blob/main",
      "Https://github.com/x/y/blob/main",
      "hTtPs://github.com/x/y/blob/main/",
    ] as const;

    // When/Then: each override normalizes to lowercase https in the source href.
    for (const sourceLinkBase of cases) {
      process.env.LANDO_DOCS_SOURCE_LINK_BASE = sourceLinkBase;
      const resolution = await resolveComponentFrame(CAPTURED_PROPS, "run");
      expect(resolution.status).toBe("captured");
      if (resolution.status !== "captured") throw new Error("expected a captured frame");
      expect(resolution.frame.sourceHref).toBe("https://github.com/x/y/blob/main/docs/guides/demo.mdx#L11");
    }
  });

  test("returns a missing transcript result when the capture is absent", async () => {
    // Given: a request whose fixture does not exist.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;

    // When: the component looks up a frame from an unknown scenario.
    const resolution = await resolveComponentFrame(
      {
        "data-guide-id": "demo",
        "data-scenario-id": "absent",
        "data-source-file": "docs/guides/demo.mdx",
        "data-source-line": "11",
      },
      "run",
      "lando start",
    );

    // Then: the build-safe missing placeholder is returned.
    expect(resolution).toEqual({
      status: "missing",
      reason: "transcript",
      label: "No captured output yet",
    });
  });
});

describe("transcriptRequestFor", () => {
  test("returns undefined when props lack data-guide-id", () => {
    expect(
      transcriptRequestFor({
        "data-scenario-id": "happy-path",
      }),
    ).toBeUndefined();
  });

  test("returns undefined when props lack data-scenario-id", () => {
    expect(
      transcriptRequestFor({
        "data-guide-id": "demo",
      }),
    ).toBeUndefined();
  });

  test("defaults variant to empty string when data-variant is absent", () => {
    expect(
      transcriptRequestFor({
        "data-guide-id": "demo",
        "data-scenario-id": "happy-path",
      }),
    ).toEqual({ guideId: "demo", scenarioId: "happy-path", variant: "" });
  });

  test("passes through an explicit data-variant", () => {
    expect(
      transcriptRequestFor({
        "data-guide-id": "demo",
        "data-scenario-id": "happy-path",
        "data-variant": "php=v8-3",
      }),
    ).toEqual({ guideId: "demo", scenarioId: "happy-path", variant: "php=v8-3" });
  });
});

describe("frameKeyFor", () => {
  test("accepts a numeric data-source-line", () => {
    expect(
      frameKeyFor(
        {
          "data-source-file": "docs/guides/demo.mdx",
          "data-source-line": 11,
        },
        "run",
      ),
    ).toEqual({ kind: "run", sourceFile: "docs/guides/demo.mdx", sourceLine: 11 });
  });

  test("accepts a numeric-string data-source-line", () => {
    expect(
      frameKeyFor(
        {
          "data-source-file": "docs/guides/demo.mdx",
          "data-source-line": "11",
        },
        "run",
      ),
    ).toEqual({ kind: "run", sourceFile: "docs/guides/demo.mdx", sourceLine: 11 });
  });

  test("rejects zero, negative, non-integer, and missing data-source-file", () => {
    expect(
      frameKeyFor(
        {
          "data-source-file": "docs/guides/demo.mdx",
          "data-source-line": 0,
        },
        "run",
      ),
    ).toBeUndefined();
    expect(
      frameKeyFor(
        {
          "data-source-file": "docs/guides/demo.mdx",
          "data-source-line": -1,
        },
        "run",
      ),
    ).toBeUndefined();
    expect(
      frameKeyFor(
        {
          "data-source-file": "docs/guides/demo.mdx",
          "data-source-line": 1.5,
        },
        "run",
      ),
    ).toBeUndefined();
    expect(
      frameKeyFor(
        {
          "data-source-file": "docs/guides/demo.mdx",
          "data-source-line": "1.5",
        },
        "run",
      ),
    ).toBeUndefined();
    expect(
      frameKeyFor(
        {
          "data-source-line": 11,
        },
        "run",
      ),
    ).toBeUndefined();
  });
});

describe("resolveComponentFrame context and discovery edges", () => {
  test("returns a missing context result when props lack guide context", async () => {
    // Given: props with no data-guide-id / data-scenario-id.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;

    // When: a component resolves without the remark-injected context attrs.
    const resolution = await resolveComponentFrame({}, "run");

    // Then: the build-safe missing placeholder is returned for context.
    expect(resolution).toEqual({
      status: "missing",
      reason: "context",
      label: "No captured output yet",
    });
  });

  test("resolves to a missing transcript when the guide is absent and root is unset", async () => {
    // Given: no LANDO_DOCS_TRANSCRIPT_ROOT override and a synthetic guide id.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = "";

    // When: a fully-keyed request targets a guide that exists nowhere on disk.
    const resolution = await resolveComponentFrame(
      {
        "data-guide-id": "__no-such-guide__",
        "data-scenario-id": "happy-path",
        "data-source-file": "docs/guides/demo.mdx",
        "data-source-line": "11",
      },
      "run",
    );

    // Then: cwd-probing falls through and the transcript is missing.
    expect(resolution).toEqual({
      status: "missing",
      reason: "transcript",
      label: "No captured output yet",
    });
  });

  test("re-probes after a miss when a fallback root later gains the guide", async () => {
    // Given: a nested sandbox so parent fallback stays fully isolated.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = "";
    process.env.LANDO_DOCS_SOURCE_LINK_BASE = "";
    const sandbox = await mkdtemp(join(tmpdir(), "lando-frames-miss-"));
    const workspace = join(sandbox, "cwd");
    const guideId = `late-guide-${Date.now()}`;
    await mkdir(workspace, { recursive: true });
    try {
      process.chdir(workspace);
      const props = framePropsFor(guideId);

      // When: the first resolution finds no candidate guide directory.
      const first = await resolveComponentFrame(props, "run");

      // Then: the frame is missing, and a later fallback root is still discoverable.
      expect(first).toEqual({
        status: "missing",
        reason: "transcript",
        label: "No captured output yet",
      });

      // When: codegen materializes the guide under the parent fallback root (sandbox/).
      await writeCapturedTranscript(guidesRootUnder(sandbox), guideId);
      const second = await resolveComponentFrame(props, "run");

      // Then: discovery re-probes and captures the frame from the new root.
      expect(second.status).toBe("captured");
      if (second.status !== "captured") throw new Error("expected a captured frame after late discovery");
      expect(second.frame.commandDisplay).toBe("lando start");
    } finally {
      process.chdir(previousCwd);
      await rm(sandbox, { recursive: true, force: true });
    }
  });

  test("env override wins without replacing a previously discovered-root cache", async () => {
    // Given: discovery has already cached a successful root for this cwd+guide.
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = "";
    process.env.LANDO_DOCS_SOURCE_LINK_BASE = "";
    const workspace = await mkdtemp(join(tmpdir(), "lando-frames-cache-"));
    const overrideRoot = await mkdtemp(join(tmpdir(), "lando-frames-override-"));
    const guideId = `cached-guide-${Date.now()}`;
    try {
      await writeCapturedTranscript(guidesRootUnder(workspace), guideId);
      // Override fixture uses a different result summary so we can tell roots apart.
      const overrideGuides = guidesRootUnder(overrideRoot);
      await mkdir(join(overrideGuides, guideId), { recursive: true });
      await writeFile(
        join(overrideGuides, guideId, "happy-path.json"),
        JSON.stringify(
          {
            ...CAPTURED_TRANSCRIPT,
            guideId,
            frames: [
              CAPTURED_TRANSCRIPT.frames[0],
              {
                ...CAPTURED_TRANSCRIPT.frames[1],
                resultSummary: "from-env-override",
              },
            ],
          },
          null,
          2,
        ),
        "utf8",
      );

      process.chdir(workspace);
      const props = framePropsFor(guideId);

      const discovered = await resolveComponentFrame(props, "run");
      expect(discovered.status).toBe("captured");
      if (discovered.status !== "captured") throw new Error("expected discovered capture");
      expect(discovered.frame.resultSummary).toBe("expected exit 0");

      // When: an env override is set after discovery has been memoized.
      process.env.LANDO_DOCS_TRANSCRIPT_ROOT = overrideGuides;
      const overridden = await resolveComponentFrame(props, "run");

      // Then: the override is used for this call.
      expect(overridden.status).toBe("captured");
      if (overridden.status !== "captured") throw new Error("expected override capture");
      expect(overridden.frame.resultSummary).toBe("from-env-override");

      // When: the override is cleared.
      process.env.LANDO_DOCS_TRANSCRIPT_ROOT = "";
      const restored = await resolveComponentFrame(props, "run");

      // Then: the previously discovered root is still cached (not replaced by the override).
      expect(restored.status).toBe("captured");
      if (restored.status !== "captured") throw new Error("expected restored discovery capture");
      expect(restored.frame.resultSummary).toBe("expected exit 0");
    } finally {
      process.chdir(previousCwd);
      await rm(workspace, { recursive: true, force: true });
      await rm(overrideRoot, { recursive: true, force: true });
    }
  });
});
