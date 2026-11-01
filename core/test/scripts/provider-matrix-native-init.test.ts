import { expect, test } from "bun:test";
import { runProviderAcceptanceCell } from "../../../scripts/provider-matrix-acceptance.ts";
import { buildProviderAcceptancePlan } from "../../../scripts/provider-matrix-plan.ts";

test.each([["lando-podman6-linux"], ["podman-podman6-linux"]] as const)(
  "runs the durable live native-init wrapper in %s",
  async (cellId) => {
    // Given an existing release-blocking cell with available prerequisites.
    const recorded: (readonly string[])[] = [];
    // When the runner executes its registered checks (without invoking any runtime).
    const report = await runProviderAcceptanceCell({
      cell: buildProviderAcceptancePlan(cellId),
      runCommand: async (command) => {
        recorded.push(command);
        return {
          exitCode: command.includes("plugins/provider-lando/test/native-init.integration.test.ts") ? 1 : 0,
          stdout: "",
          stderr: "",
        };
      },
    });
    // Then a native-init regression is executed and blocks this cell.
    expect(recorded).toContainEqual([
      "bun",
      "test",
      "plugins/provider-lando/test/native-init.integration.test.ts",
    ]);
    expect(report.checks.find((check) => check.id === "native-init")?.outcome).toBe("failed");
    expect(report.outcome).toBe("failed");
  },
);
