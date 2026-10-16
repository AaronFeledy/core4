import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import { renderTomcatBumpWorkflow } from "../../../scripts/build-tomcat-bump-workflow.ts";
import { RUNTIME_BUNDLE_ACTION_PINS } from "../../../scripts/runtime-bundle-supply-chain.ts";

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
    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.checkout}`);
    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.setupBun}`);
    expect(workflow).toContain("persist-credentials: false");
    const ci = await Bun.file(resolve(import.meta.dirname, "../../../.github/workflows/ci.yml")).text();
    expect(ci).toContain("bun test plugins/service-lando/test/*.integration.test.ts");
  });
});
