import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const probePath = resolve(import.meta.dirname, "fixtures/host-terminal-probe.ts");

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

describe("host terminal attachment detection", () => {
  test("reports no attachment when Bun stdout is piped", async () => {
    // When
    const terminal = await runPipedProbe();

    // Then
    expect(terminal).toBeNull();
  });
});
