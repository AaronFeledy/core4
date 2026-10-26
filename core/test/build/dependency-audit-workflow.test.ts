import { expect, test } from "bun:test";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";
import { renderDependencyAuditWorkflow } from "../../../scripts/build-dependency-audit-workflow.ts";
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
      permissions: Schema.Record(Schema.String, Schema.String),
      steps: Schema.Array(
        Schema.Struct({
          uses: Schema.optionalKey(Schema.String),
          run: Schema.optionalKey(Schema.String),
          with: Schema.optionalKey(
            Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Boolean])),
          ),
          env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
        }),
      ),
    }),
  }),
});

test("generated audit workflow matches the checked-in YAML", async () => {
  const committed = await Bun.file(
    resolve(import.meta.dirname, "../../../.github/workflows/dependency-audit.yml"),
  ).text();
  expect(committed).toBe(renderDependencyAuditWorkflow());
  expect(() => Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(committed))).not.toThrow();
});

test("audit writes are restricted to serialized trusted default-branch runs", () => {
  const raw = Bun.YAML.parse(renderDependencyAuditWorkflow());
  const workflow = Schema.decodeUnknownSync(Workflow)(raw);
  const triggers = Schema.decodeUnknownSync(
    Schema.Struct({ on: Schema.Record(Schema.String, Schema.Unknown) }),
  )(raw).on;
  expect(Object.keys(triggers).sort()).toEqual(["schedule", "workflow_dispatch"]);
  expect(workflow.on.schedule).toEqual([{ cron: "23 5 * * *" }]);
  expect(workflow.concurrency).toEqual({ group: "dependency-audit", "cancel-in-progress": false });
  expect(workflow.permissions).toEqual({ contents: "read" });
  expect(workflow.jobs.report.permissions).toEqual({ contents: "read", issues: "write" });
  expect(workflow.jobs.report.if).toContain("github.event.repository.default_branch");
  expect(workflow.jobs.report.if).toContain("github.event_name == 'schedule'");
  expect(workflow.jobs.report.if).toContain("github.event_name == 'workflow_dispatch'");
  expect(workflow.jobs.report.steps[0]).toEqual({
    uses: RUNTIME_BUNDLE_ACTION_PINS.checkout,
    with: { "persist-credentials": false },
  });
  expect(workflow.jobs.report.steps[1]?.uses).toBe(RUNTIME_BUNDLE_ACTION_PINS.setupBun);
  expect(workflow.jobs.report.steps.filter((step) => step.env?.GH_TOKEN)).toHaveLength(1);
  expect(renderDependencyAuditWorkflow()).not.toContain("continue-on-error");
});

test("Dependabot groups only minor and patch updates for both ecosystems", async () => {
  const raw = Bun.YAML.parse(
    await Bun.file(resolve(import.meta.dirname, "../../../.github/dependabot.yml")).text(),
  );
  const config = Schema.decodeUnknownSync(
    Schema.Struct({
      version: Schema.Literal(2),
      updates: Schema.Array(
        Schema.Struct({
          "package-ecosystem": Schema.String,
          directory: Schema.Literal("/"),
          schedule: Schema.Struct({ interval: Schema.Literal("weekly") }),
          groups: Schema.Record(
            Schema.String,
            Schema.Struct({
              patterns: Schema.Array(Schema.String),
              "update-types": Schema.Array(Schema.String),
            }),
          ),
        }),
      ),
    }),
  )(raw);
  expect(config.updates.map((update) => update["package-ecosystem"]).sort()).toEqual([
    "bun",
    "github-actions",
  ]);
  for (const update of config.updates) {
    expect(Object.values(update.groups)).toEqual([{ patterns: ["*"], "update-types": ["minor", "patch"] }]);
  }
});
