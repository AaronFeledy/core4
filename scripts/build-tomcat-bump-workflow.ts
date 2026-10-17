import { resolve } from "node:path";
import { renderMaintenanceWorkflow } from "./maintenance-workflow.ts";

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
bun test plugins/service-lando/test/tomcat.test.ts plugins/service-lando/test/tomcat-port.test.ts core/test/scripts/tomcat-update.test.ts core/test/scripts/tomcat-catalog.test.ts core/test/build/tomcat-bump-workflow.test.ts
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
