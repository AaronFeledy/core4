import { expect, test } from "bun:test";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";
import { renderStockArtifactAgeCanaryWorkflow } from "../../../scripts/build-stock-artifact-age-canary-workflow.ts";
import { RUNTIME_BUNDLE_ACTION_PINS } from "../../../scripts/runtime-bundle-supply-chain.ts";

const Workflow = Schema.Struct({
  on: Schema.Struct({
    schedule: Schema.Array(Schema.Struct({ cron: Schema.String })),
    workflow_dispatch: Schema.Null,
  }),
  permissions: Schema.Record(Schema.String, Schema.String),
  concurrency: Schema.Struct({ group: Schema.String, "cancel-in-progress": Schema.Literal(false) }),
  jobs: Schema.Struct({
    report: Schema.Struct({
      if: Schema.String,
      "timeout-minutes": Schema.Number,
      steps: Schema.Array(
        Schema.Struct({
          uses: Schema.optionalKey(Schema.String),
          run: Schema.optionalKey(Schema.String),
          with: Schema.optionalKey(
            Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
          ),
        }),
      ),
    }),
  }),
});

test("generated canary workflow matches the checked-in YAML", async () => {
  const committed = await Bun.file(
    resolve(import.meta.dirname, "../../../.github/workflows/stock-artifact-age-canary.yml"),
  ).text();
  expect(committed).toBe(renderStockArtifactAgeCanaryWorkflow());
  expect(() => Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(committed))).not.toThrow();
});

test("canary runs weekly off the PR CI path and never fails the job for stale tags", () => {
  const raw = Bun.YAML.parse(renderStockArtifactAgeCanaryWorkflow());
  const workflow = Schema.decodeUnknownSync(Workflow)(raw);
  const triggers = Schema.decodeUnknownSync(
    Schema.Struct({ on: Schema.Record(Schema.String, Schema.Unknown) }),
  )(raw).on;
  expect(Object.keys(triggers).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(workflow.on.schedule).toEqual([{ cron: "41 6 * * 1" }]);
  expect(workflow.concurrency).toEqual({ group: "stock-artifact-age-canary", "cancel-in-progress": false });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.report.if).toContain("github.event.repository.default_branch");
  expect(workflow.jobs.report.if).toContain("github.event_name == 'schedule'");
  expect(workflow.jobs.report.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(workflow.jobs.report.steps[0]).toEqual({
    uses: RUNTIME_BUNDLE_ACTION_PINS.checkout,
    with: { "persist-credentials": false },
  });
  expect(workflow.jobs.report.steps[1]?.uses).toBe(RUNTIME_BUNDLE_ACTION_PINS.setupBun);
  expect(
    workflow.jobs.report.steps.some((step) => step.run === "bun run scripts/stock-artifact-age-canary.ts"),
  ).toBe(true);
  expect(renderStockArtifactAgeCanaryWorkflow()).not.toContain("continue-on-error");
  expect(renderStockArtifactAgeCanaryWorkflow()).not.toContain("pull_request");
});
