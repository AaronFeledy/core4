import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { renderComposeVendorBumpWorkflow } from "../../../scripts/build-compose-vendor-bump-workflow.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/compose-vendor-bump.yml");

describe("compose-go bump workflow", () => {
  test("committed workflow matches its generator and parses as YAML", async () => {
    const committed = await Bun.file(workflowPath).text();

    expect(committed).toBe(renderComposeVendorBumpWorkflow());
    expect(() => Bun.YAML.parse(committed)).not.toThrow();
  });

  test("runs on a unique weekly schedule and manual dispatch with PR-authoring permissions", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain("name: compose-vendor-bump");
    expect(workflow).toContain("  schedule:");
    expect(workflow).toContain("    - cron: '0 12 * * 1'");
    expect(workflow).toContain("  workflow_dispatch:");
    expect(workflow).toContain("  contents: write");
    expect(workflow).toContain("  pull-requests: write");
  });

  test("checks the latest compose-go tag against the pin and bumps only when newer", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain("          fetch-depth: 0");
    expect(workflow).toContain("gh api --paginate repos/compose-spec/compose-go/tags --jq '.[].name'");
    expect(workflow).toContain("selectNewerComposeGoTag");
    expect(workflow).toContain("bun run codegen:compose-vendor --tag");
  });

  test("reports the vendored key path diff and opens or updates a single rolling PR", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain("git show HEAD:spec/compose/vendor/compose-spec.json");
    expect(workflow).toContain("bun run scripts/report-compose-schema-diff.ts");
    expect(workflow).toContain("automation/compose-go-bump");
    expect(workflow).toContain("gh pr list --state open --head automation/compose-go-bump");
    expect(workflow).toContain("gh pr create");
  });

  test("delegates classification to the coverage gate without auto-classifying keys", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).not.toContain("bun run check:compose-coverage");
    expect(workflow).not.toContain("dispositions");
  });
});
