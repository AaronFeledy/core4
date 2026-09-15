import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { buildWorkflowPerformancePlan } from "../../../scripts/workflow-performance-plan.ts";
import { runWorkflowPerformanceSample } from "../../../scripts/workflow-performance-sample.ts";

test.each(["mysql-import", "postgres-import", "mysql-snapshot-restore", "postgres-snapshot-restore"])(
  "stages identical fixture bytes inside the consuming app for %s",
  async (id) => {
    // Given an externally generated fixture, including non-ASCII bytes.
    const rootDir = await mkdtemp(join(tmpdir(), "perf-inputs-"));
    const fixturePath = join(rootDir, "source.sql");
    const bytes = Buffer.from("SELECT 'é';\n");
    await writeFile(fixturePath, bytes);
    const lane = buildWorkflowPerformancePlan({ runId: "inputs" }).lanes.find((lane) => lane.id === id);
    if (lane === undefined) throw new Error("missing database lane");
    let imported = false;
    try {
      // When either preparation or measurement consumes the fixture.
      const result = await runWorkflowPerformanceSample({
        lane,
        binary: "/lando",
        rootDir,
        index: 0,
        key: id,
        fixturePath,
        runCommand: async (command) => {
          if (command.id === "db:import" || command.id === "prepare:import") {
            const path = command.argv[2];
            if (path === undefined) throw new Error("missing fixture argument");
            // Then containment and exact bytes hold before import executes.
            expect(relative(command.cwd, path).startsWith("..")).toBe(false);
            expect(Buffer.from(await Bun.file(path).arrayBuffer())).toEqual(bytes);
            imported = true;
          }
          return { id: command.id, durationMs: 0, exitCode: 0, stdout: "", stderr: "" };
        },
      });
      expect(imported).toBe(true);
      if (!("sample" in result)) throw new Error("unexpected skip");
      expect(result.sample.stagedFixture).toMatchObject({
        bytes: bytes.byteLength,
        sha256: new Bun.CryptoHasher("sha256").update(bytes).digest("hex"),
      });
    } finally {
      await rm(rootDir, { recursive: true, force: true });
    }
  },
);
