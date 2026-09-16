import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWorkflowPerformancePlan } from "../../../scripts/workflow-performance-plan.ts";
import { runWorkflowPerformanceSample } from "../../../scripts/workflow-performance-sample.ts";

test("failed sample evidence omits free-form diagnostics without authoritative secret context", async () => {
  // Given a setup failure containing a custom non-environment secret and private paths.
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-performance-redaction-"));
  const lane = buildWorkflowPerformancePlan({ runId: "redaction" }).lanes[0];
  if (lane === undefined) throw new Error("missing workflow performance lane");
  const secret = "custom-nonenv-secret-989";

  try {
    // When the real sample boundary retains the failed setup result.
    const result = await runWorkflowPerformanceSample({
      lane,
      binary: "/fake/lando",
      rootDir,
      index: 0,
      key: "redaction",
      runCommand: async (command) => {
        if (command.id === "prepare:setup") {
          return {
            id: command.id,
            durationMs: 12,
            exitCode: 17,
            stdout: `setup ${secret} /var/private/lando`,
            stderr:
              "failed at /home/private/runtime C:\\Users\\private\\lando \\\\private-host\\lando$\\runtime",
            diagnostic: {
              domain: "image-pull",
              failureKind: "generic",
              transportKind: "connect",
            },
          };
        }
        return { id: command.id, durationMs: 1, exitCode: 0, stdout: "", stderr: "" };
      },
    });

    // Then command identity/status remain while all untrusted diagnostics are omitted.
    if (!("sample" in result)) throw new Error("unexpected skipped sample");
    const step = result.sample.steps[0];
    expect(step).toMatchObject({ id: "prepare:setup", exitCode: 17, durationMs: 12 });
    expect(step?.stdout).toBe("");
    expect(step?.stderr).toBe("[diagnostic evidence omitted]");
    expect(step?.diagnostic).toEqual({
      domain: "image-pull",
      failureKind: "generic",
      transportKind: "connect",
    });
    const retained = `${step?.stdout ?? ""}\n${step?.stderr ?? ""}`;
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain("/home/private");
    expect(retained).not.toContain("/var/private");
    expect(retained).not.toContain("C:\\Users\\private");
    expect(retained).not.toContain("\\\\private-host\\lando$");
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});
