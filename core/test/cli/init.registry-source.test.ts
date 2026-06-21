import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseInitSourceFlags } from "../../src/cli/commands/init-source.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const cliEntry = resolve(repoRoot, "core/bin/lando.ts");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-init-registry-source-")));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const runSpawnedCli = async (args: ReadonlyArray<string>, cwd: string): Promise<RunResult> => {
  const proc = Bun.spawn({
    cmd: [process.execPath, cliEntry, ...args],
    cwd,
    env: { ...process.env, LANDO_USER_DATA_ROOT: join(cwd, "lando-data") },
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

describe("lando init registry source parsing", () => {
  test("shared parser maps --source=registry --id into InitAppOptions fields", () => {
    expect(parseInitSourceFlags({ source: "registry", id: "drupal-10" })).toEqual({
      source: "registry",
      id: "drupal-10",
    });
  });

  test("shared parser maps --source=registry --id --path into InitAppOptions fields", () => {
    expect(parseInitSourceFlags({ source: "registry", id: "drupal-10", path: "sub" })).toEqual({
      source: "registry",
      id: "drupal-10",
      path: "sub",
    });
  });

  test("shared parser rejects --source=registry without --id with one message", () => {
    expect(() => parseInitSourceFlags({ source: "registry" })).toThrow(
      "lando init --source=registry requires --id=<recipe-id>.",
    );
  });
});

describe("lando init registry source dispatch parity", () => {
  test("OCLIF path reports the shared --source=registry missing --id message", async () => {
    await withTempCwd(async (dir) => {
      const result = await runSpawnedCli(["init", "--source=registry", "--no-interactive"], dir);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("lando init --source=registry requires --id=<recipe-id>.");
    });
  });
});

describe("lando init registry source compiled dispatch parity", () => {
  test("compiled dispatch reports the shared --source=registry missing --id message", async () => {
    const { runCli } = await import("../../src/cli/run.ts");
    const writes: string[] = [];
    const originalWrite = process.stderr.write.bind(process.stderr) as typeof process.stderr.write;
    const previousExitCode = process.exitCode;
    try {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = ((
        chunk: string | Uint8Array,
      ) => {
        writes.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
        return true;
      }) as typeof process.stderr.write;
      process.exitCode = undefined;
      await runCli({
        argv: ["init", "--source=registry", "--no-interactive"],
        rootUrl: "file:///$bunfs/lando.ts",
      });
      expect(process.exitCode).toBe(1);
      expect(writes.join("")).toContain("lando init --source=registry requires --id=<recipe-id>.");
    } finally {
      (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalWrite;
      process.exitCode = previousExitCode ?? 0;
    }
  });
});
