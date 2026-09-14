import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildWorkflowPerformancePlan } from "../../../scripts/workflow-performance-plan.ts";
import { runWorkflowPerformanceSample } from "../../../scripts/workflow-performance-sample.ts";

test.each([false, true])(
  "releases owned stores only after successful teardown (failure=%s)",
  async (failure) => {
    // Given independent image stores plus retained evidence and unrelated data.
    const rootDir = await mkdtemp(join(tmpdir(), "perf-stores-"));
    const lane = buildWorkflowPerformancePlan({ runId: "stores" }).lanes[0];
    if (lane === undefined) throw new Error("missing lane");
    let runtimeRoot = "";
    let store = "";
    const evidence = join(rootDir, "report.log");
    await writeFile(evidence, "retained");
    try {
      // When a timed-out sample is finalized with an independent cleanup deadline.
      const result = await runWorkflowPerformanceSample({
        lane,
        binary: "/lando",
        rootDir,
        key: "stores",
        index: 0,
        sampleTimeoutMs: 0,
        runCommand: async (command) => {
          runtimeRoot = command.env.XDG_RUNTIME_DIR ?? "";
          store = join(command.env.LANDO_USER_DATA_ROOT ?? "", "runtime", "storage");
          if (command.id !== "cleanup:storage-helpers") {
            await mkdir(store, { recursive: true });
            await writeFile(join(store, "owned-image"), "image");
          }
          expect(command.signal).toBeUndefined();
          expect(command.timeoutMs).toBe(30_000);
          expect(existsSync(runtimeRoot)).toBe(true);
          if (command.id === "cleanup:storage") await rm(store, { recursive: true });
          return {
            id: command.id,
            durationMs: 0,
            exitCode: failure && command.id === "cleanup:runtime" ? 1 : 0,
            stdout: "",
            stderr: "",
          };
        },
      });
      // Then failure retains roots, while confirmed teardown removes stores, not evidence.
      expect(existsSync(store)).toBe(failure);
      expect(existsSync(runtimeRoot)).toBe(failure);
      expect(await Bun.file(evidence).text()).toBe("retained");
      if (!("sample" in result)) throw new Error("unexpected skip");
      expect(result.sample.outcome).toBe("failed");
      expect(result.sample.steps[0]?.exitCode).toBe(124);
    } finally {
      await rm(rootDir, { recursive: true, force: true });
      if (runtimeRoot) await rm(runtimeRoot, { recursive: true, force: true });
    }
  },
);
