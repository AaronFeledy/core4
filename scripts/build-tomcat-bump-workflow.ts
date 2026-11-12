import { resolve } from "node:path";
import { renderMaintenanceWorkflow } from "./maintenance-workflow.ts";
import { testSelectionCommand } from "./test-selections.ts";

export const renderTomcatBumpWorkflow = (): string =>
  renderMaintenanceWorkflow({
    name: "tomcat-bump",
    cron: "30 4 * * *",
    branch: "automation/tomcat-bump",
    ownedPaths: ["plugins/service-lando/tomcat"],
    proposal: {
      name: "Prepare and check paired Tomcat update",
      prepare: `BASELINE="$RUNNER_TEMP/tomcat-baseline"
mkdir -p "$BASELINE"
for file in pins.json server-9.xml server-10.xml server-11.xml; do
  git show "origin/main:plugins/service-lando/tomcat/$file" > "$BASELINE/$file"
done
bun run update:tomcat`,
      checkAndReport: `bun run codegen
${testSelectionCommand("tomcat-bump")}
TITLE="bump paired Tomcat images and configuration"
BODY_FILE="$RUNNER_TEMP/tomcat-pr.md"
bun run scripts/report-tomcat-update.ts "$BASELINE" plugins/service-lando/tomcat > "$BODY_FILE"`,
    },
  });

if (import.meta.main) {
  await Bun.write(
    resolve(import.meta.dirname, "../.github/workflows/tomcat-bump.yml"),
    renderTomcatBumpWorkflow(),
  );
}
