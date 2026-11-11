import { expect, test } from "bun:test";
import { resolve } from "node:path";
import * as Schema from "effect/Schema";
import { renderRetargetActionBumpWorkflow } from "../../../scripts/build-retarget-action-bump-workflow.ts";
import { RUNTIME_BUNDLE_ACTION_PINS } from "../../../scripts/runtime-bundle-supply-chain.ts";

const Step = Schema.Struct({
  uses: Schema.optionalKey(Schema.String),
  run: Schema.optionalKey(Schema.String),
  with: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Union([Schema.String, Schema.Number, Schema.Boolean])),
  ),
});

const Workflow = Schema.Struct({
  on: Schema.Struct({
    pull_request_target: Schema.Struct({
      types: Schema.Array(Schema.String),
      paths: Schema.Array(Schema.String),
    }),
  }),
  permissions: Schema.Struct({ contents: Schema.Literal("read") }),
  jobs: Schema.Struct({
    retarget: Schema.Struct({
      if: Schema.String,
      permissions: Schema.Struct({ contents: Schema.Literal("write") }),
      steps: Schema.Array(Step),
    }),
  }),
});

test("retarget workflow is generated and only replays Dependabot pin diffs from the base branch", async () => {
  const committed = await Bun.file(
    resolve(import.meta.dirname, "../../../.github/workflows/retarget-action-bump.yml"),
  ).text();
  const rendered = renderRetargetActionBumpWorkflow();
  expect(committed).toBe(rendered);

  const workflow = Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(committed));
  const retarget = workflow.jobs.retarget;
  const checkout = retarget.steps.find((step) => step.uses === RUNTIME_BUNDLE_ACTION_PINS.checkout);
  const run = retarget.steps.find((step) => step.run?.includes("retarget-action-bump.ts"))?.run ?? "";

  expect(workflow.on.pull_request_target.paths).toEqual([".github/workflows/**"]);
  expect(retarget.if).toBe(
    "github.event.pull_request.user.login == 'dependabot[bot]' && github.event.pull_request.head.repo.full_name == github.repository",
  );
  expect(checkout?.with?.ref).toBe("${{ github.event.pull_request.base.sha }}");
  expect(checkout?.with?.["persist-credentials"]).toBe(false);
  expect(run).toContain('bun run scripts/retarget-action-bump.ts --base "$BASE_SHA" --head "$HEAD_SHA"');
  expect(run).toContain("refusing to push workflow edits with GITHUB_TOKEN");
  expect(rendered).not.toContain("ref: ${{ github.event.pull_request.head.sha }}");
});
