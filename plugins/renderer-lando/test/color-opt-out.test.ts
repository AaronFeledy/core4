import { expect, test } from "bun:test";
import { stripAnsi } from "@lando/renderer/console-layout";
import { createBufferedRendererIO } from "@lando/renderer/io";
import { MessageWarnEvent } from "@lando/sdk/events";
import { DateTime } from "effect";
import { renderLandoLine } from "../src/format.ts";
import { capabilitiesForIO } from "../src/renderer-capabilities.ts";
import { makeTaskTreeSubstrateHandler } from "../src/task-tree-substrate-handler.ts";
import { TREE_FIXTURES } from "./frame-fixtures.ts";

const chromaticSGR = new RegExp(
  `${String.fromCharCode(27)}\\[(?:\\d+;)*(?:3[0-7]|9[0-7]|4[0-7]|10[0-7]|38;[\\d;]+|48;[\\d;]+)(?:;\\d+)*m`,
  "u",
);

for (const fixture of TREE_FIXTURES) {
  test(`${fixture.id} keeps headless frame layout when host color is disabled`, async () => {
    // Given
    const render = async (noColor: boolean) => {
      const frames: string[] = [];
      const io = createBufferedRendererIO({ isTTY: true, noColor, terminalColumns: 40 });
      const handler = makeTaskTreeSubstrateHandler(
        io,
        {
          setFooter: (lines) => {
            frames.push(lines.join("\n"));
          },
          clearFooter: () => {},
          commitScrollback: () => {},
          rememberScrollback: () => {},
          requestLive: () => {},
          dropLive: () => {},
          enterFullTail: () => {},
          exitFullTail: async () => {},
          dispose: async () => {},
        },
        capabilitiesForIO(io).color,
      );
      try {
        for (const event of fixture.events) await handler.consume(event);
        return frames.join("\n");
      } finally {
        handler.dispose();
      }
    };
    const colored = await render(false);
    // When
    const monochrome = await render(true);
    // Then
    expect(colored).toMatch(chromaticSGR);
    expect(monochrome).not.toMatch(chromaticSGR);
    expect(stripAnsi(monochrome)).toBe(stripAnsi(colored));
  });
}

test("warning notices preserve wrapped text when color is disabled", () => {
  // Given
  const event = MessageWarnEvent.make({
    body: "A warning that wraps across several lines in a narrow terminal.",
    timestamp: DateTime.makeUnsafe("2026-06-18T12:00:00.000Z"),
  });
  const colored = renderLandoLine(event, true, 30, true);
  // When
  const monochrome = renderLandoLine(event, true, 30, false);
  // Then
  expect(colored).toMatch(chromaticSGR);
  expect(monochrome).not.toMatch(chromaticSGR);
  expect(stripAnsi(monochrome ?? "")).toBe(stripAnsi(colored ?? ""));
});
