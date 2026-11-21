import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { Schema } from "effect";
import { pinnedAction } from "../../../scripts/action-pins.ts";
import { renderNodeReleasesBumpWorkflow } from "../../../scripts/build-node-releases-bump-workflow.ts";

const Workflow = Schema.Struct({
  on: Schema.Struct({
    schedule: Schema.Array(Schema.Struct({ cron: Schema.String })),
    workflow_dispatch: Schema.Null,
  }),
  jobs: Schema.Struct({
    bump: Schema.Struct({
      steps: Schema.Array(Schema.Struct({ run: Schema.optionalKey(Schema.String) })),
    }),
  }),
});

describe("Node releases bump workflow", () => {
  test("matches generated YAML and uses reviewed actions with no persisted credentials", async () => {
    // Given / When
    const workflow = renderNodeReleasesBumpWorkflow();
    const committed = await Bun.file(
      resolve(import.meta.dirname, "../../../.github/workflows/node-releases-bump.yml"),
    ).text();

    // Then
    expect(committed).toBe(workflow);
    expect(() => Schema.decodeUnknownSync(Workflow)(Bun.YAML.parse(workflow))).not.toThrow();
    expect(workflow).toContain(`uses: ${pinnedAction("actions/checkout")}`);
    expect(workflow).toContain(`uses: ${pinnedAction("oven-sh/setup-bun")}`);
    expect(workflow).toContain("persist-credentials: false");
    expect(workflow).toContain("  actions: write");
    expect(workflow).toContain("bun run update:node-releases");
    expect(workflow).toContain("bun run test:selection node-releases-bump");
    expect(workflow).toContain("bun run scripts/report-node-releases-update.ts");
    expect(workflow).toContain("plugins/service-lando/node/releases.json");
  });
});
