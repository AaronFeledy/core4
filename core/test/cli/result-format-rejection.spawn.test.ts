import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repoRoot = resolve(import.meta.dir, "../../..");

interface RunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

const runLando = async (args: ReadonlyArray<string>): Promise<RunResult> => {
  const root = await mkdtemp(join(tmpdir(), "lando-result-format-"));
  try {
    const proc = Bun.spawn({
      cmd: [process.execPath, "core/bin/lando.ts", ...args],
      cwd: repoRoot,
      env: {
        ...process.env,
        LANDO_USER_DATA_ROOT: join(root, "data"),
        LANDO_USER_CACHE_ROOT: join(root, "cache"),
        LANDO_USER_STATE_ROOT: join(root, "state"),
        LANDO_LOG_LEVEL: "none",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    return { exitCode, stdout, stderr };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

describe("a format the command does not implement", () => {
  test("--format=table on a command with no table render fails instead of printing text", async () => {
    const result = await runLando(["version", "--format=table"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("RendererSelectionError");
    expect(result.stderr).toContain("meta:version");
    expect(result.stderr).toContain("text, json, yaml");
    // The human render must not have run.
    expect(result.stderr).not.toContain("@lando/core 0.0.0");
  });

  test("a prose command that advertised table is refused instead of printing text", async () => {
    const result = await runLando(["recipes:validate", "--format=table"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("RendererSelectionError");
    expect(result.stderr).toContain("meta:recipes:validate");
    expect(result.stderr).toContain("text, json, yaml");
    expect(result.stderr).not.toContain("valid recipe manifest");
  });

  test("--format=ndjson answers a machine request with a machine failure envelope", async () => {
    const result = await runLando(["version", "--format=ndjson"]);

    expect(result.exitCode).toBe(2);
    const envelope = JSON.parse(result.stdout) as {
      readonly ok: boolean;
      readonly command: string;
      readonly error: { readonly _tag: string; readonly remediation: string };
    };
    expect(envelope.ok).toBe(false);
    expect(envelope.command).toBe("meta:version");
    expect(envelope.error._tag).toBe("RendererSelectionError");
    expect(envelope.error.remediation).toContain("text, json, yaml");
  });

  test("an unsupported format is not laundered into a key listing by --json", async () => {
    const result = await runLando(["version", "--format=table", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain('"core"');
  });
});

describe("a format the command does implement", () => {
  test("a table command still renders its table", async () => {
    const result = await runLando(["recipes:list", "--format=table"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Bundled recipes");
  });

  test("the universal formats stay universal", async () => {
    const result = await runLando(["version", "--format=yaml"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.startsWith("apiVersion: v4\n")).toBe(true);
  });
});
