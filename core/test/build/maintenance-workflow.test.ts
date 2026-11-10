import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { renderComposeVendorBumpWorkflow } from "../../../scripts/build-compose-vendor-bump-workflow.ts";
import { renderTomcatBumpWorkflow } from "../../../scripts/build-tomcat-bump-workflow.ts";
import { createMaintenanceFixture, workflowScripts } from "./support/maintenance-workflow-harness.ts";

for (const domain of ["tomcat", "compose"] as const) {
  const render = domain === "tomcat" ? renderTomcatBumpWorkflow : renderComposeVendorBumpWorkflow;
  describe.skipIf(process.platform === "win32")(`${domain} generated maintenance shell`, () => {
    test("does not publish or fetch candidate bytes when current without a pending branch", async () => {
      // Given
      await using fixture = await createMaintenanceFixture({ domain, mode: "current" });
      // When
      const result = await fixture.proposal(render());
      // Then
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await fixture.git("ls-remote", "--heads", "origin", fixture.branch)).toBe("");
      const commands = await fixture.commands();
      expect(commands).not.toContain("gh pr");
      expect(commands).not.toContain("gh workflow");
      if (domain === "compose") expect(commands).not.toContain("bun run codegen:compose-vendor");
    });

    test("publishes only owned paths and creates a PR with explicit CI dispatch", async () => {
      // Given
      await using fixture = await createMaintenanceFixture({ domain });
      // When
      const result = await fixture.proposal(render());
      // Then
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await fixture.git("diff", "--name-only", "main", `origin/${fixture.branch}`)).toBe(
        fixture.owned,
      );
      expect(await fixture.git("diff", "--cached", "--name-only")).toBe("unrelated.txt");
      expect(await Bun.file(join(fixture.work, "untracked.txt")).text()).toBe("untracked\n");
      const commands = await fixture.commands();
      expect(commands).toContain(`gh pr create --base main --head ${fixture.branch}`);
      expect(commands).toContain(`gh workflow run ci.yml --ref ${fixture.branch}`);
      if (domain === "compose")
        expect(commands).toContain("--title bump compose-go vendored schema to v2.2.0");
    });

    test("stops after a rejected PR list without creating, editing, or dispatching", async () => {
      // Given
      const stderr = "GraphQL: Resource not accessible by integration (repository.pullRequests)\n";
      await using fixture = await createMaintenanceFixture({
        domain,
        ghFailure: { operation: "list", exitCode: 31, stderr },
      });
      // When
      const result = await fixture.proposal(render());
      // Then
      expect(result.exitCode, result.stderr).toBe(31);
      expect(result.stderr).toContain(stderr);
      const commands = await fixture.commands();
      expect(commands).toContain(`gh pr list --state open --head ${fixture.branch}`);
      expect(commands).not.toContain("gh pr create");
      expect(commands).not.toContain("gh pr edit");
      expect(commands).not.toContain("gh workflow");
    });

    for (const operation of ["create", "edit"] as const) {
      test(`preserves the pushed candidate and diagnostic after a rejected PR ${operation}`, async () => {
        // Given
        const stderr =
          operation === "create"
            ? "GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)\n"
            : "GraphQL: Resource not accessible by integration (updatePullRequest)\n";
        const exitCode = operation === "create" ? 32 : 33;
        await using fixture = await createMaintenanceFixture({
          domain,
          existingPr: operation === "edit",
          ghFailure: { operation, exitCode, stderr },
        });
        // When
        const result = await fixture.proposal(render());
        // Then
        expect(result.exitCode, result.stderr).toBe(exitCode);
        expect(result.stderr).toContain(stderr);
        const candidate = await fixture.git("rev-parse", "HEAD");
        expect(await fixture.git("ls-remote", "--heads", "origin", fixture.branch)).toBe(
          `${candidate}\trefs/heads/${fixture.branch}`,
        );
        expect(await fixture.git("diff", "--name-only", "main", candidate)).toBe(fixture.owned);
        const commands = await fixture.commands();
        expect(commands).toContain(`gh pr ${operation}`);
        expect(commands).not.toContain(`gh pr ${operation === "create" ? "edit" : "create"}`);
        expect(commands).not.toContain("gh workflow");
      });
    }

    test("reconciles pending updates without losing manual commits when no newer candidate exists", async () => {
      // Given
      await using fixture = await createMaintenanceFixture({ domain, pending: "bump", existingPr: true });
      // When
      const result = await fixture.proposal(render());
      // Then
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await fixture.git("merge-base", fixture.manualCommit, `origin/${fixture.branch}`)).toBe(
        fixture.manualCommit,
      );
      expect(await fixture.git("merge-base", "main", `origin/${fixture.branch}`)).toBe(
        await fixture.git("rev-parse", "main"),
      );
      expect(await fixture.git("show", `origin/${fixture.branch}:manual.txt`)).toBe("human classification");
      const commands = await fixture.commands();
      expect(commands).toContain(`gh pr edit ${fixture.branch}`);
      expect(commands).not.toContain("gh pr create");
      expect(commands).toContain(`gh workflow run ci.yml --ref ${fixture.branch}`);
      if (domain === "compose") expect(commands).toContain("bun run codegen:compose-vendor --tag v2.2.0");
      expect((await fixture.git("log", "-1", "--format=%P")).split(" ")).toHaveLength(2);
    });

    test("stops before publishing when domain work fails", async () => {
      // Given
      await using fixture = await createMaintenanceFixture({
        domain,
        mode: domain === "tomcat" ? "checks-fail" : "update-fail",
      });
      // When
      const result = await fixture.proposal(render());
      // Then
      expect(result.exitCode).toBe(domain === "tomcat" ? 23 : 22);
      expect(await fixture.git("ls-remote", "--heads", "origin", fixture.branch)).toBe("");
      expect(await fixture.commands()).not.toContain("gh pr");
      expect(await fixture.commands()).not.toContain("gh workflow");
    });

    test("does not propose a pending branch containing only unrelated human changes", async () => {
      // Given
      await using fixture = await createMaintenanceFixture({
        domain,
        mode: "current",
        pending: "manual-only",
      });
      // When
      const result = await fixture.proposal(render());
      // Then
      expect(result.exitCode, result.stderr).toBe(0);
      expect(await fixture.commands()).not.toContain("gh pr");
      expect(await fixture.commands()).not.toContain("gh workflow");
      expect(await fixture.git("rev-parse", `origin/${fixture.branch}`)).toBe(fixture.manualCommit);
    });

    test("does not publish if the candidate report fails", async () => {
      // Given
      await using fixture = await createMaintenanceFixture({ domain, mode: "report-fail" });
      // When
      const result = await fixture.proposal(render());
      // Then
      expect(result.exitCode).toBe(24);
      expect(await fixture.git("ls-remote", "--heads", "origin", fixture.branch)).toBe("");
      expect(await fixture.commands()).not.toContain("gh pr");
    });

    for (const exactMatch of [true, false]) {
      test(`reports failure outside a checkout by ${exactMatch ? "commenting on the exact-title issue" : "creating an issue despite a similar title"}`, async () => {
        // Given
        await using fixture = await createMaintenanceFixture({ domain });
        const title = `${domain === "tomcat" ? "tomcat-bump" : "compose-vendor-bump"} automation failure`;
        const issues = [
          { number: 12, title: `${title} previous` },
          ...(exactMatch ? [{ number: 34, title }] : []),
        ];
        // When
        const result = await fixture.failure(render(), issues);
        // Then
        expect(result.exitCode, result.stderr).toBe(0);
        const commands = await fixture.commands();
        expect(commands).toContain("repo=fixture/repository");
        expect(commands).toContain(
          exactMatch ? "gh issue comment 34 --body" : `gh issue create --title ${title} --body`,
        );
        expect(commands).not.toContain(exactMatch ? "gh issue create" : "gh issue comment");
        expect(commands).toContain("https://example.invalid/fixture/repository/actions/runs/42");
      });
    }

    test("scopes failure reporting to the workflow's fork repository", async () => {
      // Given
      const repository = "fork-owner/core4";
      await using fixture = await createMaintenanceFixture({ domain, repository });
      // When
      const result = await fixture.failure(render());
      // Then
      expect(result.exitCode, result.stderr).toBe(0);
      const commands = await fixture.commands();
      expect(commands).toContain("gh issue list --state open --limit 100 --json number,title --jq");
      expect(commands).toContain(`repo=${repository}`);
      expect(commands).toContain(`https://example.invalid/${repository}/actions/runs/42`);
      expect(commands).not.toContain("fixture/repository");
    });
  });
}

test("both failure jobs declare repository scope without requiring checkout", () => {
  // Given / When
  const jobs = [renderTomcatBumpWorkflow(), renderComposeVendorBumpWorkflow()].map(workflowScripts);
  // Then
  for (const job of jobs) {
    const { GH_REPO } = job.failureEnv;
    expect(GH_REPO).toBe("${{ github.repository }}");
  }
});
