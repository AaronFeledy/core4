import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildWorkflowPerformancePlan } from "../../../scripts/workflow-performance-plan.ts";
import { runWorkflowPerformanceSample } from "../../../scripts/workflow-performance-sample.ts";

test("failed sample evidence redacts authoritative secrets and private paths before retention", async () => {
  // Given a setup failure and Podman service log containing private diagnostics.
  const rootDir = await mkdtemp(join(tmpdir(), "workflow-performance-redaction-"));
  const lane = buildWorkflowPerformancePlan({ runId: "redaction" }).lanes[0];
  if (lane === undefined) throw new Error("missing workflow performance lane");
  const secret = "0;1";
  const previousSecret = process.env.LANDO_SECRET_PR989_SERVICE_LOG;
  process.env.LANDO_SECRET_PR989_SERVICE_LOG = secret;

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
          const dataRoot = command.env.LANDO_USER_DATA_ROOT;
          if (dataRoot === undefined) throw new Error("missing sample data root");
          await mkdir(join(dataRoot, "runtime/run"), { recursive: true });
          await writeFile(join(dataRoot, "runtime/run/service.log"), `service secret=${secret}`);
          return {
            id: command.id,
            durationMs: 12,
            exitCode: 17,
            stdout: `setup ${secret} /var/private/lando`,
            stderr:
              "failed at /home/private/runtime C:\\Users\\private\\lando \\\\private-host\\lando$\\runtime",
          };
        }
        return { id: command.id, durationMs: 1, exitCode: 0, stdout: "", stderr: "" };
      },
    });

    // Then command identity/status remain and both command and service evidence are safe.
    if (!("sample" in result)) throw new Error("unexpected skipped sample");
    const step = result.sample.steps[0];
    expect(step).toMatchObject({ id: "prepare:setup", exitCode: 17, durationMs: 12 });
    const retained = `${step?.stdout ?? ""}\n${step?.stderr ?? ""}`;
    expect(retained).toContain("[podman service log tail]");
    expect(retained).toContain("[redacted]");
    expect(retained).toContain("[path]");
    expect(retained).not.toContain(secret);
    expect(retained).not.toContain("/home/private");
    expect(retained).not.toContain("/var/private");
    expect(retained).not.toContain("C:\\Users\\private");
    expect(retained).not.toContain("\\\\private-host\\lando$");
  } finally {
    process.env.LANDO_SECRET_PR989_SERVICE_LOG = previousSecret;
    await rm(rootDir, { recursive: true, force: true });
  }
});
