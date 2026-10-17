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
    expect(await fixture.commands()).toContain("gh issue comment 42 --body");
  },
);
