import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "bun:test";

test("history CLI retains malformed prior JSON as an incompatible row", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-history-cli-"));
  try {
    const createdAt = new Date().toISOString();
    const current = {
      schemaVersion: 1,
      series: { provider: "lando", platform: "linux-x64", fixtureSet: "db-v1" },
      run: {
        id: "current",
        attempt: 1,
        commit: "abc",
        generatedAt: createdAt,
        architecture: "x64",
        runner: "ubuntu-24.04",
      },
      versions: { binary: "4", runtime: "6", provider: "4" },
      fileSync: { eligible: false, reason: "no sync measurement" },
      fixtures: [],
      lanes: [],
    };
    await mkdir(join(root, "prior"));
    await writeFile(join(root, "current.json"), JSON.stringify(current));
    await writeFile(
      join(root, "index.tsv"),
      `prior\t${createdAt}\tsuccess\nmissing\t${createdAt}\tsuccess\n`,
    );
    await writeFile(join(root, "prior", "report.json"), "{truncated");

    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        resolve(import.meta.dirname, "../../../scripts/workflow-performance-history-cli.ts"),
        "--current",
        join(root, "current.json"),
        "--index",
        join(root, "index.tsv"),
        "--artifact-root",
        root,
        "--summary",
        join(root, "summary.json"),
        "--markdown",
        join(root, "summary.md"),
      ],
      env: { ...process.env, GITHUB_STEP_SUMMARY: join(root, "step-summary.md") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stderr] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    expect({ exitCode, stderr }).toEqual({ exitCode: 0, stderr: "" });
    const summary = await Bun.file(join(root, "summary.json")).json();
    expect(summary.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ runId: "prior", status: "incompatible" }),
        expect.objectContaining({ runId: "missing", status: "missing" }),
      ]),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
