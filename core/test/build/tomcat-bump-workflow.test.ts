import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import { renderTomcatBumpWorkflow } from "../../../scripts/build-tomcat-bump-workflow.ts";
import { RUNTIME_BUNDLE_ACTION_PINS } from "../../../scripts/runtime-bundle-supply-chain.ts";
import { createMaintenanceFixture } from "./support/maintenance-workflow-harness.ts";

const Workflow = Schema.Struct({
  on: Schema.Struct({
    schedule: Schema.Array(Schema.Struct({ cron: Schema.String })),
    workflow_dispatch: Schema.Null,
  }),
  jobs: Schema.Struct({
    bump: Schema.Struct({ steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })) }),
  }),
});

describe("Tomcat bump workflow", () => {
  test("matches generated YAML and uses reviewed actions with no persisted credentials", async () => {
    // Given / When
    const workflow = renderTomcatBumpWorkflow();
    const committed = await Bun.file(
      resolve(import.meta.dirname, "../../../.github/workflows/tomcat-bump.yml"),
    ).text();
    // Then
    expect(committed).toBe(workflow);
    expect(() => Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(workflow))).not.toThrow();
    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.checkout} # v7.0.1`);
    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.setupBun}`);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("  actions: write");
    const ci = await Bun.file(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml")).text();
    expect(ci).toContain("bun test plugins/service-lando/test/*.integration.test.ts");
  });

  test.skipIf(process.platform === "win32").each([false, true])(
    "fails when CI dispatch is rejected after PR reconciliation (existing PR: %s)",
    async (existingPr) => {
      // Given: either a new proposal or a pending rolling branch.
      await using fixture = await createMaintenanceFixture({
        domain: "tomcat",
        mode: "dispatch-fail",
        existingPr,
        ...(existingPr ? { pending: "bump" } : {}),
      });
      // When: execute the actual generated proposal shell.
      const result = await fixture.proposal(renderTomcatBumpWorkflow());
      // Then: dispatch occurs after PR create/edit and its failure fails the job.
      expect(result.exitCode, result.stderr).toBe(37);
      const commands = await fixture.commands();
      const pr = commands.indexOf(`gh pr ${existingPr ? "edit" : "create"}`);
      expect(pr).toBeGreaterThanOrEqual(0);
      expect(commands.indexOf(`gh workflow run ci.yml --ref ${fixture.branch}`)).toBeGreaterThan(pr);
    },
  );
});
