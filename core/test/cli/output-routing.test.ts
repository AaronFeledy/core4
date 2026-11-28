import { expect, test } from "bun:test";
import { RESULT_FORMATS, type ResultFormat } from "../../src/cli/format-flags";
import { resolveOutputRouting } from "../../src/cli/output-routing";
import { RENDERER_MODES, type RendererMode } from "../../src/cli/renderer-selection";

const stdout = {
  text: ["human", "human", "human", "human"],
  table: ["human", "human", "human", "human"],
  ndjson: ["frames", "frames", "frames", "frames"],
  json: ["envelope", "frames", "frames", "frames"],
  yaml: ["envelope", "envelope", "envelope", "envelope"],
} as const satisfies Record<ResultFormat, readonly string[]>;
const events = {
  lando: {
    text: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    table: ["mode-narration", "mode-narration", "mode-narration", "mode-narration"],
    ndjson: ["frames", "frames", "frames", "frames"],
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
    ndjson: ["frames", "frames", "frames", "frames"],
    json: ["none", "frames", "frames", "frames"],
    yaml: ["none", "none", "none", "none"],
  },
  json: {
    text: ["json-event-dump", "json-event-dump", "json-event-dump", "json-event-dump"],
    table: ["json-event-dump", "json-event-dump", "json-event-dump", "json-event-dump"],
    ndjson: ["frames", "frames", "frames", "frames"],
    json: ["notifications-only", "frames", "frames", "frames"],
    yaml: ["notifications-only", "notifications-only", "notifications-only", "notifications-only"],
  },
  verbose: {
    text: ["verbose-dump", "verbose-dump", "verbose-dump", "verbose-dump"],
    table: ["verbose-dump", "verbose-dump", "verbose-dump", "verbose-dump"],
    ndjson: ["frames", "frames", "frames", "frames"],
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
        const input = { rendererMode, format, frames: declaresStreaming, live, report: false };
        // When
        const routing = resolveOutputRouting(input);
        // Then
        expect(routing.stdout).toBe(stdout[format][index]);
        expect(routing.events).toBe(events[rendererMode][format][index]);
        expect(routing.sink).toBe(format === "yaml" ? "none" : sink);
        expect("serialization" in routing ? routing.serialization : undefined).toBe(
          routing.stdout === "envelope" ? (format === "yaml" ? "yaml" : "json") : undefined,
        );
      });
    }
  }
}

const jsonEnvelope = {
  stdout: "envelope",
  serialization: "json",
  events: "notifications-only",
  sink: "none",
} as const;
const jq = { jqExpression: ".ok" };
const keys = { projectResultKeys: ["name"] };

test.each([
  ["framed-jq", "json", true, false, jq, jsonEnvelope],
  ["framed-keys", "json", true, false, keys, jsonEnvelope],
  ["live-jq", "json", false, true, jq, { ...jsonEnvelope, sink: "discard" }],
  ["non-framed-jq", "json", false, false, jq, jsonEnvelope],
  ["yaml-selection", "yaml", true, true, keys, { ...jsonEnvelope, serialization: "yaml" }],
  ["ndjson-selection", "ndjson", true, true, jq, { stdout: "frames", events: "frames", sink: "live" }],
] as const)("routes result selection: %s", (_case, format, frames, live, selection, expected) => {
  // The dispatcher refuses selection with ndjson before reaching this router.
  expect(
    resolveOutputRouting({ rendererMode: "json", format, frames, live, report: false }, selection),
  ).toEqual(expected);
});

for (const rendererMode of RENDERER_MODES) {
  test(`routes a ${rendererMode} ndjson report command to its report frames with mode narration`, () => {
    // Given a command that renders its own ndjson report and streams no frames
    const input = { rendererMode, format: "ndjson" as const, frames: false, live: false, report: true };
    // When
    const routing = resolveOutputRouting(input);
    // Then
    expect(routing).toEqual({ stdout: "report", events: events[rendererMode].text[0], sink: "none" });
  });
  test(`routes ${rendererMode} json for a report command to its envelope`, () => {
    const routing = resolveOutputRouting({
      rendererMode,
      format: "json",
      frames: false,
      live: false,
      report: true,
    });
    expect(routing.stdout).toBe("envelope");
  });
}
