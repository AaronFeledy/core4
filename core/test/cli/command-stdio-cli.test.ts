import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = new URL("../../bin/lando.ts", import.meta.url).pathname;

test.each([["--format=json"], ["--format=yaml"], ["--json=service"], ["--jq=."]])(
  "writes a lifecycle failure only to stderr when dump stdout is requested for %j",
  async (control) => {
    const cwd = await mkdtemp(join(tmpdir(), "lando-payload-result-"));
    try {
      const child = Bun.spawn([process.execPath, cli, "db:export", "-", control], {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);

      expect(exitCode).toBe(1);
      expect(stdout).toBe("");
      expect(Bun.YAML.parse(stderr)).toMatchObject({
        ok: false,
        error: { _tag: "LandofileNotFoundError" },
      });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
);

test.each([
  ["stdout", "db:export", "text"],
  ["stdin", "db:import", "text"],
  ["stdout", "db:export", "json"],
  ["stdin", "db:import", "json"],
  ["stdout", "db:export", "yaml"],
  ["stdin", "db:import", "yaml"],
] as const)("refuses terminal %s before the %s lifecycle in %s", async (stream, command, format) => {
  const runner = new URL("../../src/cli/index.ts", import.meta.url).pathname;
  const script = `
    import { runCli } from ${JSON.stringify(runner)};
    Object.defineProperty(process[${JSON.stringify(stream)}], "isTTY", { value: true });
    await runCli({
      argv: [${JSON.stringify(command)}, "-", "--renderer=json", ${JSON.stringify(`--format=${format}`)}],
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
  if (format !== "text") {
    expect(Bun.YAML.parse(stream === "stdout" ? stderr : stdout)).toMatchObject({
      ok: false,
      error: { _tag: "CommandStdioError", stream, reason: "terminal" },
    });
    expect(stream === "stdout" ? stdout : stderr).toBe("");
    return;
  }
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

test.each(["--format=json", "--format=yaml"])(
  "routes flag errors to stderr with payload stdout for %s",
  async (format) => {
    const child = Bun.spawn([process.execPath, cli, "db:export", "-", "--unknown-flag", format], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(stdout).toBe("");
    expect(Bun.YAML.parse(stderr)).toMatchObject({ ok: false, error: { _tag: "UnknownCliFlagError" } });
    expect(exitCode).toBe(2);
  },
);

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

test("routes an unsupported-format refusal to stderr when stdout carries the dump", async () => {
  // Given a dash export with a format plugin commands don't support.
  const child = Bun.spawn([process.execPath, cli, "db:export", "-", "--format=ndjson"], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);

  // Then stdout stays empty and the refusal envelope is on stderr.
  expect(exitCode).toBe(2);
  expect(stdout).toBe("");
  expect(JSON.parse(stderr.trim().split("\n").at(-1) ?? "")).toMatchObject({
    ok: false,
    command: "db:export",
  });
});
