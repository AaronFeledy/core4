import { expect, test } from "bun:test";
import { ContainerTransportError, runtimeRemediation } from "@lando/container-runtime/transport";
import { ProviderUnavailableError } from "@lando/sdk/errors";
import { buildBugReport, renderPlainBugReport } from "../../src/cli/bug-report.ts";

test("an unreachable runtime renders runtime guidance once without a bug-report instruction", () => {
  const error = new ProviderUnavailableError({
    providerId: "lando",
    remediation: `${runtimeRemediation} Run \`lando setup\` if the runtime is not installed or healthy.`,
    operation: "run",
    message: "The runtime is unavailable.",
    cause: new ContainerTransportError({
      kind: "connect",
      operation: "run",
      message: "Failed to connect to the container runtime socket.",
    }),
  });

  const report = buildBugReport({ error, context: { commandId: "db:import" }, sourceEnv: {} });
  const lines = renderPlainBugReport(report).split("\n");
  const remediation = lines.filter((line) => line.startsWith("  ↳ "));

  expect(lines.some((line) => line.includes("github.com"))).toBe(false);
  expect(remediation).toEqual([`  ↳ ${error.remediation}`]);
  expect(report.remediation).toBe(error.remediation);
});
