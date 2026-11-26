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

  test("--format=ndjson answers a machine request with a stream result frame", async () => {
    const result = await runLando(["version", "--format=ndjson"]);

    expect(result.exitCode).toBe(2);
    const frame = JSON.parse(result.stdout) as {
      readonly _tag: string;
      readonly envelope: {
        readonly ok: boolean;
        readonly command: string;
        readonly error: { readonly _tag: string; readonly remediation: string };
      };
    };
    expect(frame._tag).toBe("result");
    expect(frame.envelope.ok).toBe(false);
    expect(frame.envelope.command).toBe("meta:version");
    expect(frame.envelope.error._tag).toBe("RendererSelectionError");
    expect(frame.envelope.error.remediation).toContain("text, json, yaml");
  });

  test("an unsupported format is not laundered into a key listing by --json", async () => {
    const result = await runLando(["version", "--format=table", "--json"]);

    expect(result.exitCode).toBe(2);
    expect(result.stdout).not.toContain('"core"');
  });
});

describe("an ndjson run that fails before the command runs", () => {
  // Nothing ran, so the failure is one stream result frame.
  for (const [label, args, command] of [
    ["an unknown flag on a streaming command", ["logs", "--format=ndjson", "--no-such-flag"], "app:logs"],
    ["an unknown command", ["--format=ndjson", "no-such-command-anywhere"], "cli:unknown-command"],
  ] as const) {
    test(`reports ${label} as one stream result frame`, async () => {
      const result = await runLando(args);

      expect(result.exitCode).toBe(2);
      const lines = result.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      const frame = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
      expect(frame._tag).toBe("result");
      const envelope = frame.envelope as Record<string, unknown>;
      expect(envelope).toMatchObject({ apiVersion: "v4", command, ok: false });
    });
  }
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
