import { expect, test } from "bun:test";
import { RESULT_FORMATS, type ResultFormat } from "../../src/cli/format-flags";
import { resolveOutputRouting } from "../../src/cli/output-routing";
import { RENDERER_MODES, type RendererMode } from "../../src/cli/renderer-selection";

const stdout = {
  text: ["human", "human", "human", "human"],
  table: ["human", "human", "human", "human"],
  ndjson: ["human", "human", "human", "human"],
  json: ["envelope", "frames", "frames", "frames"],
  yaml: ["envelope", "envelope", "envelope", "envelope"],
} as const satisfies Record<ResultFormat, readonly string[]>;
const events = {
  lando: {
    text: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    table: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    ndjson: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    json: ["silent-lando-consumer", "frames", "frames", "frames"],
    yaml: [
      "silent-lando-consumer",
      "silent-lando-consumer",
      "silent-lando-consumer",
      "silent-lando-consumer",
    ],
  },
  plain: {
    text: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    table: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    ndjson: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    json: ["none", "frames", "frames", "frames"],
    yaml: ["none", "none", "none", "none"],
  },
  json: {
    text: ["json-event-dump", "json-event-dump", "json-event-dump", "json-event-dump"],
    table: ["json-event-dump", "json-event-dump", "json-event-dump", "json-event-dump"],
    ndjson: ["json-event-dump", "json-event-dump", "json-event-dump", "json-event-dump"],
    json: ["notifications-only", "frames", "frames", "frames"],
    yaml: ["notifications-only", "notifications-only", "notifications-only", "notifications-only"],
  },
  verbose: {
    text: ["verbose-dump", "verbose-dump", "verbose-dump", "verbose-dump"],
    table: ["verbose-dump", "verbose-dump", "verbose-dump", "verbose-dump"],
    ndjson: ["verbose-dump", "verbose-dump", "verbose-dump", "verbose-dump"],
    json: ["verbose-dump", "frames", "frames", "frames"],
    yaml: ["verbose-dump", "verbose-dump", "verbose-dump", "verbose-dump"],
  },
} as const satisfies Record<RendererMode, Record<ResultFormat, readonly string[]>>;

for (const rendererMode of RENDERER_MODES) {
  for (const format of RESULT_FORMATS) {
    for (const [index, declaresStreaming, live, sink] of [
      [0, false, false, "none"],
      [1, false, true, "live"],
      [2, true, false, "none"],
      [3, true, true, "live"],
    ] as const) {
      test(`routes ${rendererMode}/${format}, streaming=${declaresStreaming}, live=${live}`, () => {
        // Given
        const input = { rendererMode, format, declaresStreaming, live };
        // When
        const routing = resolveOutputRouting(input);
        // Then
        expect(routing.stdout).toBe(stdout[format][index]);
        expect(routing.events).toBe(events[rendererMode][format][index]);
        expect(routing.sink).toBe(format === "yaml" ? "none" : sink);
      });
    }
  }
}
