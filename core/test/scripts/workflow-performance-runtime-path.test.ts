import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkflowPerformancePlan } from "../../../scripts/workflow-performance-plan.ts";
import { runWorkflowPerformanceSample } from "../../../scripts/workflow-performance-sample.ts";

test("keeps rootlessport socket paths short when report roots and sample names are deep", async () => {
  // Given a deep artifact directory and Podman's longest rootlessport socket suffix.
  const root = await mkdtemp(join(tmpdir(), "perf-path-"));
  const rootDir = join(root, "artifact-directory".repeat(5));
  const suffix = "libpod/tmp/rootlessport4294967295/.bp.sock";
  const lane = buildWorkflowPerformancePlan({ runId: "path" }).lanes[0];
  if (lane === undefined) throw new Error("Expected a start lane");
  let runtimeRoot = "";
  let socketBytes = 0;
  try {
    // When the sample prepares its runtime and fails before measurement.
    await runWorkflowPerformanceSample({
      lane,
      binary: "/lando",
      rootDir,
      index: 0,
      key: "perf-path-cold-first-start-1",
      runCommand: async (command) => {
        if (command.id === "prepare:setup") {
          runtimeRoot = command.env.XDG_RUNTIME_DIR ?? "";
          socketBytes = Buffer.byteLength(join(runtimeRoot, suffix));
        }
        return { id: command.id, durationMs: 0, exitCode: 1, stdout: "", stderr: "preparation failed" };
      },
    });
    // Then the Unix address fits sun_path and failed teardown retains the runtime directory.
    expect(runtimeRoot).not.toBe("");
    expect(socketBytes).toBeLessThan(108);
    expect(existsSync(runtimeRoot)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
    if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
  }
});
