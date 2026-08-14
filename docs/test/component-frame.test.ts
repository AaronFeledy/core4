import { resolve } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { componentFramePropsFor } from "../src/components/component-frame.ts";

const TRANSCRIPT_ROOT = resolve(import.meta.dir, "fixtures", "transcripts");

const CAPTURED_PROPS = {
  "data-guide-id": "demo",
  "data-scenario-id": "happy-path",
  "data-source-file": "docs/guides/demo.mdx",
  "data-source-line": "11",
  command: "lando start",
} as const;

const previousRoot = process.env.LANDO_DOCS_TRANSCRIPT_ROOT;
const previousBase = process.env.LANDO_DOCS_SOURCE_LINK_BASE;

afterEach(() => {
  process.env.LANDO_DOCS_TRANSCRIPT_ROOT = previousRoot ?? "";
  process.env.LANDO_DOCS_SOURCE_LINK_BASE = previousBase ?? "";
});

describe("componentFramePropsFor", () => {
  test("keeps only data-* keys in dataAttributes", async () => {
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;

    const { dataAttributes } = await componentFramePropsFor(CAPTURED_PROPS, "run");

    expect(dataAttributes).toEqual({
      "data-guide-id": "demo",
      "data-scenario-id": "happy-path",
      "data-source-file": "docs/guides/demo.mdx",
      "data-source-line": "11",
    });
    expect(Object.keys(dataAttributes).every((name) => name.startsWith("data-"))).toBe(true);
  });

  test("defines frame for a captured fixture and passes resolution through", async () => {
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;

    const { frame, resolution } = await componentFramePropsFor(CAPTURED_PROPS, "run");

    expect(resolution.status).toBe("captured");
    expect(frame).toBeDefined();
    if (resolution.status !== "captured") throw new Error("expected a captured frame");
    expect(frame).toBe(resolution.frame);
  });

  test("leaves frame undefined for each missing reason", async () => {
    process.env.LANDO_DOCS_TRANSCRIPT_ROOT = TRANSCRIPT_ROOT;

    const context = await componentFramePropsFor({}, "run");
    expect(context.resolution).toEqual({
      status: "missing",
      reason: "context",
      label: "No captured output yet",
    });
    expect(context.frame).toBeUndefined();

    const transcript = await componentFramePropsFor(
      {
        "data-guide-id": "demo",
        "data-scenario-id": "absent",
        "data-source-file": "docs/guides/demo.mdx",
        "data-source-line": "11",
      },
      "run",
    );
    expect(transcript.resolution).toEqual({
      status: "missing",
      reason: "transcript",
      label: "No captured output yet",
    });
    expect(transcript.frame).toBeUndefined();

    const missingFrame = await componentFramePropsFor(
      {
        "data-guide-id": "demo",
        "data-scenario-id": "happy-path",
        "data-source-file": "docs/guides/demo.mdx",
        "data-source-line": "999",
      },
      "run",
    );
    expect(missingFrame.resolution).toEqual({
      status: "missing",
      reason: "frame",
      label: "No captured output yet",
    });
    expect(missingFrame.frame).toBeUndefined();
  });
});
