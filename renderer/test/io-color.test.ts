import { expect, test } from "bun:test";
import { Socket } from "node:net";
import { hostDisablesColor, isDumbTerminal } from "@lando/renderer";
import {
  createBufferedRendererIO,
  createStdioRendererIO,
  withStdioTerminalNewlines,
} from "@lando/renderer/io";
import { narrationIO } from "@lando/sdk/renderer";

const stream = () =>
  Object.assign(new Socket(), {
    isTTY: true,
    columns: 80,
    rows: 24,
    clearLine: () => true,
    clearScreenDown: () => true,
    cursorTo: () => true,
    moveCursor: () => true,
    getWindowSize: (): [number, number] => [80, 24],
    getColorDepth: () => 1,
    hasColors: () => false,
  });

test.each([
  [{}, false],
  [{ NO_COLOR: "" }, false],
  [{ NO_COLOR: "1" }, true],
  [{ NO_COLOR: "0" }, true],
  [{ TERM: "dumb" }, true],
  [{ FORCE_COLOR: "1", NO_COLOR: "0" }, true],
] as const)("resolves the host color fact from %j", (env, expected) => {
  // Given
  const stdout = stream();
  const stderr = stream();
  // When
  const io = createStdioRendererIO(stdout, stderr, undefined, { env });
  // Then
  expect(hostDisablesColor(env)).toBe(expected);
  expect(io.noColor).toBe(expected);
  expect(narrationIO(io).noColor).toBe(expected);
  expect(withStdioTerminalNewlines(io, false).noColor).toBe(expected);
  expect(withStdioTerminalNewlines(narrationIO(io), false).noColor).toBe(expected);
  expect(isDumbTerminal(env)).toBe("TERM" in env && env.TERM === "dumb");
  expect(io.externalOutputStream === undefined).toBe(isDumbTerminal(env));
});

test("reconstruction keeps the color facts resolved at construction", () => {
  // Given: a caller-owned environment object that changes after construction
  const env: Record<string, string | undefined> = { NO_COLOR: "1", TERM: "dumb" };
  const io = createStdioRendererIO(stream(), stream(), undefined, { env });
  env.NO_COLOR = undefined;
  env.TERM = "xterm-256color";
  // When
  const rebuilt = withStdioTerminalNewlines(io, false);
  // Then
  expect(rebuilt.noColor).toBe(true);
  expect(rebuilt.externalOutputStream).toBeUndefined();
});

test("buffered narration retains the explicit opt-out", () => {
  // Given
  const io = createBufferedRendererIO({ noColor: true });
  // When
  const narration = narrationIO(io);
  // Then
  expect(narration.noColor).toBe(true);
});
