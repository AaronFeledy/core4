import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Config } from "@oclif/core";

import SshCommand from "../../src/cli/oclif/commands/app/ssh.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runCli = async (args: ReadonlyArray<string>, cwd = repoRoot): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
};

describe("lando ssh — Alpha provider-exec TTY command behavior (US-022)", () => {
  test("registers `ssh` and `app:ssh` as a top-level alias and OCLIF id", async () => {
    const config = await Config.load({ root: resolve(repoRoot, "core"), ignoreManifest: true });
    const rootPlugin = config.plugins.get(config.pjson.name);
    if (rootPlugin === undefined) throw new Error("OCLIF root plugin missing");
    const aliasesById = new Map(
      rootPlugin.commands.map((command) => [command.id, command.aliases ?? []] as const),
    );
    expect(aliasesById.get("app:ssh")).toContain("ssh");
    expect(SshCommand.aliases).toContain("ssh");
  });

  test("`--subsystem` fails with a structured NotImplementedError (Beta defer)", async () => {
    const result = await runCli(["ssh", "--subsystem=sftp"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("NotImplementedError");
    expect(result.stderr).toContain("commandId: app:ssh");
    expect(result.stderr).toContain("specSection: spec/08-cli-and-tooling.md");
    expect(result.stderr).toContain("subsystem");
  });

  test("`--sidecar` fails with a structured NotImplementedError (Beta defer)", async () => {
    const result = await runCli(["ssh", "--sidecar"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("NotImplementedError");
    expect(result.stderr).toContain("commandId: app:ssh");
    expect(result.stderr).toContain("sidecar");
  });
});
