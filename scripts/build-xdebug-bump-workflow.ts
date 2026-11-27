import { resolve } from "node:path";
import { renderMaintenanceWorkflow } from "./maintenance-workflow.ts";
import { testSelectionCommand } from "./test-selections.ts";
import { XDEBUG_PINS_PATH } from "./xdebug-pins.ts";

export const renderXdebugBumpWorkflow = (): string =>
  renderMaintenanceWorkflow({
    name: "xdebug-bump",
    cron: "43 5 * * *",
    branch: "automation/xdebug-bump",
    ownedPaths: [XDEBUG_PINS_PATH],
    proposal: {
      name: "Prepare and check Xdebug pin update",
      prepare: `BASELINE="$RUNNER_TEMP/xdebug-baseline.json"
CANDIDATE="${XDEBUG_PINS_PATH}"
git show "origin/main:$CANDIDATE" > "$BASELINE"
bun run update:xdebug "$BASELINE"`,
      checkAndReport: `bun run codegen
CHANGED="$(bun run scripts/report-xdebug-update.ts "$BASELINE" "$CANDIDATE" --changed-versions)"
if [ -n "$CHANGED" ]; then
  mapfile -t PHP_VERSIONS <<< "$CHANGED"
  bun run scripts/check-xdebug-build.ts "\${PHP_VERSIONS[@]}"
fi
${testSelectionCommand("xdebug-bump")}
TITLE="bump Xdebug pins"
BODY_FILE="$RUNNER_TEMP/xdebug-pr.md"
bun run scripts/report-xdebug-update.ts "$BASELINE" "$CANDIDATE" > "$BODY_FILE"`,
    },
  });

if (import.meta.main) {
  await Bun.write(
    resolve(import.meta.dirname, "../.github/workflows/xdebug-bump.yml"),
    renderXdebugBumpWorkflow(),
  );
}
