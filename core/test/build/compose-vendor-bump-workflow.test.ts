import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";

import { renderComposeVendorBumpWorkflow } from "../../../scripts/build-compose-vendor-bump-workflow.ts";
import { RUNTIME_BUNDLE_ACTION_PINS } from "../../../scripts/runtime-bundle-supply-chain.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const workflowPath = resolve(repoRoot, ".github/workflows/compose-vendor-bump.yml");

describe("compose-go bump workflow", () => {
  test("committed workflow matches its generator and parses as YAML", async () => {
    const committed = await Bun.file(workflowPath).text();

    expect(committed).toBe(renderComposeVendorBumpWorkflow());
    expect(() => Bun.YAML.parse(committed)).not.toThrow();
  });

  test("runs daily with concurrency and automation permissions", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain("name: compose-vendor-bump");
    expect(workflow).toContain("  schedule:");
    expect(workflow).toContain("    - cron: '0 4 * * *'");
    expect(workflow).toContain("  workflow_dispatch:");
    expect(workflow).toContain("concurrency:\n  group: compose-vendor-bump\n  cancel-in-progress: false");
    expect(workflow).toContain("  contents: write");
    expect(workflow).toContain("  pull-requests: write");
    expect(workflow).toContain("  actions: write");
    expect(workflow).toContain("  issues: write");
  });

  test("uses reviewed action pins without persisting checkout credentials", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.checkout}`);
    expect(workflow).toContain(`uses: ${RUNTIME_BUNDLE_ACTION_PINS.setupBun}`);
    expect(workflow).toContain("          persist-credentials: false");
    expect(workflow).not.toContain("actions/checkout@v5");
    expect(workflow).not.toContain("oven-sh/setup-bun@v2");
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

    expect(workflow).toContain("git show origin/main:vendor/compose/compose-spec.json");
    expect(workflow).toContain("bun run scripts/report-compose-schema-diff.ts");
    expect(workflow).toContain("automation/compose-go-bump");
    expect(workflow).toContain("gh pr list --state open --head automation/compose-go-bump");
    expect(workflow).toContain("gh pr create");
    expect(workflow).toContain("gh pr edit automation/compose-go-bump");
    expect(workflow).toContain("gh workflow run ci.yml --ref automation/compose-go-bump");
  });

  test("preserves commits already added to the rolling PR branch", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain("git fetch origin");
    expect(workflow).toContain(
      "git checkout -B automation/compose-go-bump origin/automation/compose-go-bump",
    );
    expect(workflow).toContain("git merge --no-edit origin/main");
    expect(workflow).toContain("git push origin HEAD:automation/compose-go-bump");
    expect(workflow).not.toContain("git push --force");
  });

  test("reconciles an existing bump branch when its pin is already current", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain("BRANCH_EXISTS=true");
    expect(workflow).toContain('if [ -z "$TARGET_TAG" ]; then');
    expect(workflow).toContain("git diff --quiet origin/main...HEAD -- vendor/compose/pin.json");
    expect(workflow).toContain("if ! git diff --quiet -- vendor/compose/pin.json");
  });

  test("comments on one exact-title failure issue or creates it without labels", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).toContain("  report-failure:");
    expect(workflow).toContain("    if: ${{ failure() }}");
    expect(workflow).toContain("compose-vendor-bump automation failure");
    expect(workflow).toContain(
      "${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }}",
    );
    expect(workflow).toContain("gh issue list --state open");
    expect(workflow).toContain('select(.title == "compose-vendor-bump automation failure")');
    expect(workflow).toContain('gh issue comment "$ISSUE_NUMBER" --body "$BODY"');
    expect(workflow).toContain('gh issue create --title "$TITLE" --body "$BODY"');
    expect(workflow).not.toContain("--label");
  });

  test("delegates classification to the coverage gate without auto-classifying keys", () => {
    const workflow = renderComposeVendorBumpWorkflow();

    expect(workflow).not.toContain("bun run check:compose-coverage");
    expect(workflow).not.toContain("dispositions");
  });
});
