#!/usr/bin/env bun
import { resolve } from "node:path";
import { renderMaintenanceWorkflow } from "./maintenance-workflow.ts";
import { testSelectionCommand } from "./test-selections.ts";

export const renderNodeReleasesBumpWorkflow = (): string =>
  renderMaintenanceWorkflow({
    name: "node-releases-bump",
    cron: "17 5 * * *",
    branch: "automation/node-releases-bump",
    ownedPaths: ["plugins/service-lando/node"],
    proposal: {
      name: "Prepare and check Node release schedule update",
      prepare: `BASELINE="$RUNNER_TEMP/node-releases-baseline"
mkdir -p "$BASELINE"
git show "origin/main:plugins/service-lando/node/releases.json" > "$BASELINE/releases.json"
bun run update:node-releases`,
      checkAndReport: `bun run codegen
${testSelectionCommand("node-releases-bump")}
TITLE="bump Node release schedule"
BODY_FILE="$RUNNER_TEMP/node-releases-pr.md"
bun run scripts/report-node-releases-update.ts "$BASELINE/releases.json" plugins/service-lando/node/releases.json > "$BODY_FILE"`,
    },
  });

if (import.meta.main) {
  await Bun.write(
    resolve(import.meta.dirname, "../.github/workflows/node-releases-bump.yml"),
    renderNodeReleasesBumpWorkflow(),
  );
}
