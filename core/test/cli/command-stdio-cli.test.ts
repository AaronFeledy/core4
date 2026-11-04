import { expect, test } from "bun:test";

const cli = new URL("../../bin/lando.ts", import.meta.url).pathname;

test.each([["--format=json"], ["--format=yaml"], ["--json=service"], ["--jq=."]])(
  "refuses dump stdout before the command lifecycle for %j",
  async (control) => {
    const child = Bun.spawn([process.execPath, cli, "db:export", "-", "--renderer=json", control], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);

    expect(exitCode).toBe(2);
    expect(Bun.YAML.parse(stdout)).toMatchObject({
      ok: false,
      error: { _tag: "CommandStdioError", reason: "machine-output", stream: "stdout" },
    });
    expect(stderr).not.toContain("cli-db:export-init");
    expect(stderr).not.toContain("cli-db:export-run");
    expect(stderr).not.toContain("cli-db:export-error");
  },
);

test.each([
  ["stdout", "db:export"],
  ["stdin", "db:import"],
] as const)("refuses terminal %s before the %s lifecycle", async (stream, command) => {
  const runner = new URL("../../src/cli/index.ts", import.meta.url).pathname;
  const script = `
    import { runCli } from ${JSON.stringify(runner)};
    Object.defineProperty(process[${JSON.stringify(stream)}], "isTTY", { value: true });
    await runCli({
      argv: [${JSON.stringify(command)}, "-", "--renderer=json", "--format=text"],
      rootUrl: ${JSON.stringify(cli)},
    });
  `;
  const child = Bun.spawn([process.execPath, "--eval", script], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(
    stderr
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line)),
  ).toEqual([
    expect.objectContaining({
      _tag: "message.error",
      code: "CommandStdioError",
      command,
      stream,
      reason: "terminal",
    }),
  ]);
});

test("bare --json keeps key-list mode without requesting dump stdout", async () => {
  const child = Bun.spawn([process.execPath, cli, "db:export", "-", "--json"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode).toBe(0);
  expect(stdout).toContain("service");
  expect(stdout).not.toContain("CommandStdioError");
  expect(stderr).not.toContain("CommandStdioError");
});

test("invalid plugin input still fails inside the command lifecycle", async () => {
  // Only stdio refusals skip the lifecycle; a missing required arg keeps its init and error events.
  const child = Bun.spawn([process.execPath, cli, "db:import", "--renderer=verbose"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("cli-db:import-init");
  expect(stderr).toContain("cli-db:import-error");
  expect(stderr).toContain("CommandInputValidationError");
});
