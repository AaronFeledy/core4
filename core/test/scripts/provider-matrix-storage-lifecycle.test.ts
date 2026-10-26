import { expect, test } from "bun:test";
import { runProviderAcceptanceCell } from "../../../scripts/provider-matrix-acceptance.ts";
import { buildProviderAcceptancePlan } from "../../../scripts/provider-matrix-plan.ts";

test.each([
  ["docker-engine-linux", "docker"],
  ["lando-podman6-linux", "lando"],
  ["podman-podman6-linux", "lando"],
] as const)("runs the durable live storage wrapper in %s", async (cellId, wrapper) => {
  // Given an existing release-blocking cell with available prerequisites.
  const recorded: (readonly string[])[] = [];
  // When the runner executes its registered checks (without invoking any runtime).
  const report = await runProviderAcceptanceCell({
    cell: buildProviderAcceptancePlan(cellId),
    runCommand: async (command) => {
      recorded.push(command);
      return {
        exitCode: command.includes(
          `plugins/provider-${wrapper}/test/anonymous-volume-lifecycle.integration.test.ts`,
        )
          ? 1
          : 0,
        stdout: "",
        stderr: "",
      };
    },
  });
  // Then a storage regression is executed and blocks this cell.
  expect(recorded).toContainEqual([
    "bun",
    "test",
    `plugins/provider-${wrapper}/test/anonymous-volume-lifecycle.integration.test.ts`,
  ]);
  expect(report.checks.find((check) => check.id === "storage-lifecycle")?.outcome).toBe("failed");
  expect(report.outcome).toBe("failed");
});
