import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import { pinnedActionRef } from "../../../scripts/action-pins.ts";
import { renderXdebugBumpWorkflow } from "../../../scripts/build-xdebug-bump-workflow.ts";

const Workflow = Schema.Struct({
  jobs: Schema.Record(
    Schema.String,
    Schema.Struct({
      steps: Schema.Array(Schema.Struct({ uses: Schema.optionalKey(Schema.String) })),
    }),
  ),
});

test("ships the rendered Xdebug workflow with only reviewed actions", async () => {
  const path = resolve(import.meta.dirname, "../../../.github/workflows/xdebug-bump.yml");
  const committed = await Bun.file(path).text();
  const workflow = Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(committed));

  expect(committed).toBe(renderXdebugBumpWorkflow());
  expect(
    Object.values(workflow.jobs).flatMap(({ steps }) => steps.flatMap(({ uses }) => uses ?? [])),
  ).toEqual([pinnedActionRef("actions/checkout"), pinnedActionRef("oven-sh/setup-bun")]);
});
