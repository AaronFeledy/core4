import { beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { Config } from "@oclif/core";

import InfoCommand from "../../src/cli/oclif/commands/app/info.ts";
import StartCommand from "../../src/cli/oclif/commands/app/start.ts";
import StopCommand from "../../src/cli/oclif/commands/app/stop.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreRoot = resolve(repoRoot, "core");
const binaryPath = resolve(coreRoot, "dist/lando");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface CommandWithAliases {
  readonly aliases?: ReadonlyArray<string>;
}

const runCommand = async (cmd: Array<string>, cwd = coreRoot): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd,
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

const commandAliases = (command: CommandWithAliases): ReadonlyArray<string> => command.aliases ?? [];

describe("app command aliases", () => {
  test("declare OCLIF top-level aliases on the command classes", () => {
    expect(commandAliases(StartCommand)).toContain("start");
    expect(commandAliases(StopCommand)).toContain("stop");
    expect(commandAliases(InfoCommand)).toContain("info");
  });

  test("register alias metadata in the OCLIF command manifest model", async () => {
    const config = await Config.load({ root: coreRoot, ignoreManifest: true });
    const rootPlugin = config.plugins.get(config.pjson.name);
    if (rootPlugin === undefined) throw new Error(`Unable to load OCLIF root plugin ${config.pjson.name}`);

    const aliasesById = new Map(
      rootPlugin.commands.map((command) => [command.id, command.aliases ?? []] as const),
    );

    expect(aliasesById.get("app:start")).toContain("start");
    expect(aliasesById.get("app:stop")).toContain("stop");
    expect(aliasesById.get("app:info")).toContain("info");
  });
});

describe.skipIf(process.platform !== "linux" || process.arch !== "x64")(
  "compiled app command aliases",
  () => {
    beforeAll(async () => {
      const build = await runCommand([process.execPath, "run", "build:compile"], coreRoot);
      expect(build.exitCode).toBe(0);
    }, 120_000);

    test("route top-level aliases to the same compiled handlers as their app ids", async () => {
      const cwd = await mkdtemp(join(tmpdir(), "lando-aliases-"));
      try {
        for (const [alias, appId] of [
          ["start", "app:start"],
          ["stop", "app:stop"],
          ["info", "app:info"],
        ] as const) {
          const aliasResult = await runCommand([binaryPath, alias], cwd);
          const appIdResult = await runCommand([binaryPath, appId], cwd);

          expect(aliasResult.exitCode, alias).toBe(appIdResult.exitCode);
          expect(aliasResult.stdout, alias).toBe(appIdResult.stdout);
          expect(aliasResult.stderr, alias).toBe(appIdResult.stderr);
          expect(aliasResult.exitCode, alias).not.toBe(0);
          expect(aliasResult.stderr, alias).toContain(
            "Run `lando init --full --name=<name>` to scaffold an app.",
          );
        }
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    }, 120_000);
  },
);
