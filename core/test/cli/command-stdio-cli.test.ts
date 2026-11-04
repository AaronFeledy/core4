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
    expect(stdout).toContain("CommandStdioError");
    expect(stdout).toContain("machine-output");
    expect(stderr).not.toContain("cli-db:export-init");
    expect(stderr).not.toContain("cli-db:export-error");
  },
);

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
