import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const probePath = resolve(import.meta.dirname, "fixtures/host-terminal-probe.ts");

const runTerminalProbe = async (): Promise<unknown> => {
  let stdout = "";
  let resolveTerminalExit: (() => void) | undefined;
  const terminalExited = new Promise<void>((resolve) => {
    resolveTerminalExit = resolve;
  });
  const child = Bun.spawn([process.execPath, probePath], {
    env: { ...Bun.env, TERM: "dumb", COLORTERM: "truecolor" },
    terminal: {
      name: "dumb",
      cols: 132,
      rows: 43,
      data: (_terminal, data) => {
        stdout += new TextDecoder().decode(data);
      },
      exit: () => resolveTerminalExit?.(),
    },
  });
  const exitCode = await child.exited;
  await terminalExited;
  expect(exitCode).toBe(0);
  return JSON.parse(stdout.trim());
};

describe("host terminal attachment detection", () => {
  test.skipIf(process.platform === "win32")(
    "detects facts through a real Bun POSIX pseudo-terminal",
    async () => {
      // When
      const terminal = await runTerminalProbe();

      // Then
      expect(terminal).toEqual({
        term: "dumb",
        colorterm: "truecolor",
        columns: 132,
        rows: 43,
        noColor: true,
      });
    },
  );
});
