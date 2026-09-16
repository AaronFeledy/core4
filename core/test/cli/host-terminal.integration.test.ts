import { describe, expect, test } from "bun:test";

const probePath = new URL("./fixtures/host-terminal-probe.ts", import.meta.url).pathname;

const runPipedProbe = async (): Promise<unknown> => {
  const child = Bun.spawn([process.execPath, probePath], {
    env: { ...Bun.env, TERM: "dumb", COLORTERM: "truecolor" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = await new Response(child.stdout).text();
  const stderr = await new Response(child.stderr).text();
  const exitCode = await child.exited;
  expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
  return JSON.parse(stdout.trim());
};

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
      expect(terminal).toEqual({ term: "dumb", colorterm: "truecolor", columns: 132, rows: 43 });
    },
  );

  test("reports no attachment when Bun stdout is piped", async () => {
    // When
    const terminal = await runPipedProbe();

    // Then
    expect(terminal).toBeNull();
  });
});
