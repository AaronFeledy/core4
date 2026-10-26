#!/usr/bin/env bun
import { resolve } from "node:path";
import { renderMaintenanceWorkflow } from "./maintenance-workflow.ts";

const selectNewerTagScript = [
  'const { selectNewerComposeGoTag, readComposeVendorPin } = await import("./scripts/compose-vendor.ts");',
  'const pin = await readComposeVendorPin("vendor/compose/pin.json");',
  'const candidates = (await new Response(Bun.stdin.stream()).text()).split("\\n").map((line) => line.trim()).filter(Boolean);',
  "const newer = selectNewerComposeGoTag(pin.tag, candidates);",
  "if (newer !== undefined) process.stdout.write(newer);",
].join(" ");
const readPinnedTagScript = [
  'const { readComposeVendorPin } = await import("./scripts/compose-vendor.ts");',
  'const pin = await readComposeVendorPin("vendor/compose/pin.json");',
  "process.stdout.write(pin.tag);",
].join(" ");

export const renderComposeVendorBumpWorkflow = (): string =>
  renderMaintenanceWorkflow({
    name: "compose-vendor-bump",
    cron: "0 4 * * *",
    branch: "automation/compose-go-bump",
    ownedPaths: ["vendor/compose/pin.json", "vendor/compose/compose-spec.json"],
    proposal: {
      name: "Bump compose-go vendored schema and open rolling PR",
      prepare: `TARGET_TAG="$(gh api --paginate repos/compose-spec/compose-go/tags --jq '.[].name' | bun -e '${selectNewerTagScript}')"
if [ -z "$TARGET_TAG" ]; then
  if [ "$BRANCH_EXISTS" = false ] || git diff --quiet origin/main...HEAD -- vendor/compose/pin.json vendor/compose/compose-spec.json; then
    echo "::notice title=compose-vendor-bump::compose-go pin is already current; nothing to bump."
    exit 0
  fi
  TARGET_TAG="$(bun -e '${readPinnedTagScript}')"
  echo "::notice title=compose-vendor-bump::reconciling the existing $TARGET_TAG bump branch."
else
  echo "::notice title=compose-vendor-bump::bumping compose-go pin to $TARGET_TAG"
fi
git show origin/main:vendor/compose/compose-spec.json > "$RUNNER_TEMP/old-compose-spec.json"
bun run codegen:compose-vendor --tag "$TARGET_TAG"`,
      checkAndReport: `TITLE="bump compose-go vendored schema to $TARGET_TAG"
BODY_FILE="$RUNNER_TEMP/pr-body.md"
bun run scripts/report-compose-schema-diff.ts "$RUNNER_TEMP/old-compose-spec.json" vendor/compose/compose-spec.json > "$BODY_FILE"`,
    },
  });

if (import.meta.main) {
  const output = resolve(import.meta.dirname, "../.github/workflows/compose-vendor-bump.yml");
  await Bun.write(output, renderComposeVendorBumpWorkflow());
  console.log(`[build-compose-vendor-bump-workflow] wrote ${output}`);
}
