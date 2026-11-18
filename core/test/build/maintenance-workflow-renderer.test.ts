import { expect, test } from "bun:test";
import { join } from "node:path";
import { renderMaintenanceWorkflow } from "../../../scripts/maintenance-workflow.ts";
import { createMaintenanceFixture } from "./support/maintenance-workflow-harness.ts";

test.skipIf(process.platform === "win32").each([true, false])(
  "quotes owned paths and failure metadata as shell data (existing output: %s)",
  async (existingOutput) => {
    // Given
    await using fixture = await createMaintenanceFixture({ domain: "tomcat" });
    const path = "candidate's file.txt";
    if (existingOutput) {
      await Bun.write(join(fixture.work, path), "old\n");
      await fixture.git("add", "--", path);
      await fixture.git("commit", "-m", "candidate fixture");
      await fixture.git("push", "origin", "main");
    }
    const name = "candidate's bump";
    const yaml = renderMaintenanceWorkflow({
      name,
      cron: "0 4 * * *",
      branch: fixture.branch,
      ownedPaths: [path],
      proposal: {
        name: "Prepare candidate",
        prepare: `printf 'new\\n' > "candidate's file.txt"`,
        checkAndReport: `TITLE="candidate's update"
BODY_FILE="$RUNNER_TEMP/report.md"
printf report > "$BODY_FILE"`,
      },
    });
    // When
    const proposal = await fixture.proposal(yaml);
    const failure = await fixture.failure(yaml, [{ number: 42, title: `${name} automation failure` }]);
    // Then
    expect(proposal.exitCode, proposal.stderr).toBe(0);
    expect(failure.exitCode, failure.stderr).toBe(0);
    expect(await fixture.git("show", `origin/${fixture.branch}:${path}`)).toBe("new");
    expect(await fixture.git("log", "-1", "--format=%s", `origin/${fixture.branch}`)).toBe(
      "candidate's update",
    );
    const commands = await fixture.commands();
    expect(commands).toContain("gh issue comment 42 --body");
    expect(commands).toContain("repo=fixture/repository");
    expect(commands).not.toContain("gh issue create");
  },
);

test.each([
  [["failure"], false, true],
  // GitHub reports a job stopped by timeout-minutes as cancelled, not failed.
  [["cancelled"], false, true],
  [["abandoned"], false, true],
  [["success"], false, false],
  // A run cancelled by hand cancels its jobs too, and files nothing.
  [["cancelled"], true, false],
] as const)(
  "reports a bump result of %j when the run cancelled is %p: %p",
  (results, runCancelled, expected) => {
    const yaml = renderMaintenanceWorkflow({
      name: "candidate",
      cron: "0 4 * * *",
      branch: "automation/candidate",
      ownedPaths: ["file.txt"],
      proposal: { name: "Prepare candidate", prepare: "true", checkAndReport: "true" },
    });
    const { jobs } = Bun.YAML.parse(yaml) as { jobs: Record<string, { if?: string }> };
    const condition = jobs["report-failure"]?.if;
    if (condition === undefined) throw new TypeError("Missing reporter condition");
    // The expression uses the JavaScript/GitHub boolean subset once needs.*.result is bound.
    const evaluate = new Function(
      "cancelled",
      "contains",
      "results",
      `return (${condition.slice(3, -2).replaceAll("needs.*.result", "results")});`,
    );
    expect(
      evaluate(
        () => runCancelled,
        (values: ReadonlyArray<string>, value: string) => values.includes(value),
        results,
      ),
    ).toBe(expected);
  },
);
