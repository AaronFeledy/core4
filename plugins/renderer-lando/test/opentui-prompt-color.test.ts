import { expect, test } from "bun:test";
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriteStream } from "node:tty";

import * as openTui from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";

import type { PromptDriverRequestLike } from "../src/opentui/prompt-driver-types.ts";
import { createOpenTuiPromptDriver } from "../src/opentui/prompt-driver.ts";
import { monochromePromptTerminal } from "../src/opentui/prompt-monochrome.ts";

const chromaticSgr = new RegExp(
  `${String.fromCharCode(27)}\\[(?:\\d*[;:])*(?:3[0-8]|4[0-8]|9[0-7]|10[0-7])(?:[;:]\\d*)*m`,
  "g",
);
const osc12 = new RegExp(`${String.fromCharCode(27)}\\]12;`, "g");
const cases = [
  "text",
  "number",
  "path",
  "editor",
  "textarea",
  "select",
  "described-select",
  "multiselect",
  "manual-choice",
] as const;

const capture = async (kind: (typeof cases)[number], noColor: boolean) => {
  const root = mkdtempSync(join(tmpdir(), "lando-prompt-color-"));
  const path = join(root, "output");
  const fd = openSync(path, "w");
  const stdout = new WriteStream(fd);
  stdout.write = (
    chunk: string | Uint8Array,
    encodingOrCallback?: unknown,
    callback?: (error?: Error | null) => void,
  ) => {
    writeSync(fd, Buffer.from(chunk));
    queueMicrotask(() => {
      if (typeof encodingOrCallback === "function") encodingOrCallback();
      else callback?.();
    });
    return true;
  };
  const setup = await createTestRenderer({
    width: 100,
    height: 30,
    stdout: noColor ? monochromePromptTerminal(stdout) : stdout,
    bufferedOutput: "stdout",
  });
  const controller = new AbortController();
  const request: PromptDriverRequestLike = {
    prompt: { name: "fixture", message: "Fixture", type: kind === "described-select" ? "select" : kind },
    mode: kind === "manual-choice" ? "manual-choice" : "normal",
    issue: "! Invalid fixture",
    help: "Fixture help",
    footer: [{ id: "fixture", render: (value) => `Value: ${value}` }],
    choices:
      kind === "described-select"
        ? [
            { value: "a", label: "Alpha", description: "Alpha preview" },
            { value: "b", label: "Beta", description: "Beta preview" },
          ]
        : ["Alpha", "Beta"],
  };
  const driver = createOpenTuiPromptDriver({
    noColor,
    stdout,
    loadModule: async () => openTui,
    createRenderer: async () => setup.renderer,
    startRenderer: () => {},
  });
  const outcome = driver.readRaw(request, controller.signal).then(
    () => undefined,
    (cause: unknown) => cause,
  );
  try {
    await Promise.resolve();
    await Promise.resolve();
    await setup.renderOnce();
    if (kind === "described-select") {
      await setup.mockInput.typeText("b");
      await setup.renderOnce();
    }
    const frame = setup.captureCharFrame();
    const spans = setup.captureSpans().lines.flatMap((line) => line.spans);
    const cursor = setup.renderer.getCursorState();
    controller.abort();
    expect(await outcome).toHaveProperty("name", "PromptCancelledError");
    return {
      frame,
      spans,
      cursor,
      output: readFileSync(path, "utf8"),
    };
  } finally {
    controller.abort();
    await outcome;
    stdout.destroy();
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
};

for (const kind of cases) {
  test.each([false, true])(`${kind} frame honors noColor=%j`, async (noColor) => {
    // Given / When
    const result = await capture(kind, noColor);
    // Then
    expect(result.frame).toContain("! Invalid fixture");
    if (noColor) {
      expect(result.output.match(chromaticSgr) ?? []).toHaveLength(0);
      expect(result.output.match(osc12) ?? []).toHaveLength(0);
      expect(result.spans.every((span) => span.fg.intent === "default" && span.bg.intent === "default")).toBe(
        true,
      );
    } else {
      expect(result.output.match(chromaticSgr)?.length).toBeGreaterThan(0);
      const border = result.spans.find((span) => span.text.includes("╭"));
      expect(border?.fg.toInts().slice(0, 3)).toEqual([223, 64, 144]);
    }
    if (kind === "select" || kind === "described-select" || kind === "multiselect") {
      expect(result.frame).toContain("▶");
    }
    if (kind === "described-select") {
      expect(result.frame).toContain("Beta preview");
      expect(result.frame).toMatch(/│\s+b\s+│/);
    }
    if (["text", "number", "path", "editor", "textarea", "manual-choice"].includes(kind)) {
      expect(result.cursor.visible).toBe(true);
    }
  });
}

test("cursor adapter preserves payload and non-color controls across split OSC writes", () => {
  // Given
  const root = mkdtempSync(join(tmpdir(), "lando-cursor-color-"));
  const path = join(root, "output");
  const fd = openSync(path, "w");
  const stdout = new WriteStream(fd);
  stdout.write = (chunk: string | Uint8Array) => {
    writeSync(fd, Buffer.from(chunk));
    return true;
  };
  const terminal = monochromePromptTerminal(stdout);
  const adaptedWrite = terminal.write;
  const originalWrite = stdout.write;
  try {
    // When
    terminal.write = () => true;
    terminal.write = adaptedWrite;
    for (const byte of Buffer.from("α\x1b]12;#ffffff\x07β\x1b]12;red\x1b\\\x1b[3 q\x1b[?25hγ")) {
      terminal.write(Buffer.from([byte]));
    }
    // Then
    expect(readFileSync(path, "utf8")).toBe("αβ\x1b[3 q\x1b[?25hγ");
    expect(stdout.write).toBe(originalWrite);
  } finally {
    stdout.destroy();
    closeSync(fd);
    rmSync(root, { recursive: true, force: true });
  }
});
