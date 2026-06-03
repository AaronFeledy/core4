import { describe, expect, test } from "bun:test";
import { Effect } from "effect";

import { createBufferedRendererIO } from "../../src/cli/renderer/io.ts";
import {
  makeJsonRenderer,
  makeLandoRenderer,
  makePlainRenderer,
  makeVerboseRenderer,
} from "../../src/cli/renderer/runtime.ts";

const makers = {
  plain: makePlainRenderer,
  json: makeJsonRenderer,
  verbose: makeVerboseRenderer,
  lando: makeLandoRenderer,
} as const;

describe("renderer raw output channel", () => {
  for (const [mode, make] of Object.entries(makers)) {
    test(`output.stdout writes to stdout for ${mode} (raw, no message formatting)`, () => {
      const io = createBufferedRendererIO();
      const renderer = make(io);
      Effect.runSync(renderer.output.stdout("raw-result\n"));
      expect(io.stdout()).toBe("raw-result\n");
      expect(io.stderr()).toBe("");
    });

    test(`output.stderr writes to stderr for ${mode}`, () => {
      const io = createBufferedRendererIO();
      const renderer = make(io);
      Effect.runSync(renderer.output.stderr("diagnostic\n"));
      expect(io.stderr()).toBe("diagnostic\n");
      expect(io.stdout()).toBe("");
    });
  }

  test("output channel writes verbatim (no glyph/newline injection)", () => {
    const io = createBufferedRendererIO();
    const renderer = makeJsonRenderer(io);
    Effect.runSync(renderer.output.stdout('{"ok":true}'));
    expect(io.stdout()).toBe('{"ok":true}');
  });

  test("message.* contract unchanged after output added: plain info -> stdout", () => {
    const io = createBufferedRendererIO();
    const renderer = makePlainRenderer(io);
    Effect.runSync(renderer.message.info("hello"));
    expect(io.stdout()).toContain("hello");
    expect(io.stderr()).toBe("");
  });

  test("message.* contract unchanged after output added: json info -> stderr", () => {
    const io = createBufferedRendererIO();
    const renderer = makeJsonRenderer(io);
    Effect.runSync(renderer.message.info("hello"));
    expect(io.stderr()).toContain("hello");
    expect(io.stdout()).toBe("");
  });
});
