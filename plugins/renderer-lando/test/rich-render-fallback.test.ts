import { describe, expect, test } from "bun:test";

import type { LandoEvent } from "@lando/sdk/services";

import { renderJsonLine, renderPlainLine } from "../src/format.ts";

const ts = "2026-07-17T00:00:00.000Z";

describe("rich render event plain-text fallback matrix", () => {
  test("code.snippet emits verbatim/fenced text in plain; json passthrough", () => {
    const event = {
      _tag: "code.snippet",
      code: "const x = 1",
      language: "ts",
      timestamp: ts,
    } as unknown as LandoEvent;
    expect(renderPlainLine(event)).toBe("```ts\nconst x = 1\n```");
    const json = renderJsonLine(event);
    expect(json).toContain('"event":"code.snippet"');
    expect(json).toContain("const x = 1");
  });

  test("diff.render emits verbatim unified diff", () => {
    const unified = "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n";
    const event = {
      _tag: "diff.render",
      unified,
      timestamp: ts,
    } as unknown as LandoEvent;
    expect(renderPlainLine(event)).toBe(unified);
    expect(renderJsonLine(event)).toContain('"event":"diff.render"');
  });

  test("markdown.block emits verbatim markdown source", () => {
    const event = {
      _tag: "markdown.block",
      markdown: "# Title\n\n- item",
      timestamp: ts,
    } as unknown as LandoEvent;
    expect(renderPlainLine(event)).toBe("# Title\n\n- item");
    expect(renderJsonLine(event)).toContain('"event":"markdown.block"');
  });
});
