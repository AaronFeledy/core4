import { type ExecAppResult, execApp } from "../../../commands/exec.ts";
/**
 * `lando app:exec` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const execSpec: LandoCommandSpec<ExecAppResult> = {
  id: "app:exec",
  summary: "Run a command in a Lando service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  // Real flag/arg parsing lands when LandoCommandBase.runEffect is wired.
  run: () => execApp({ service: "", command: [] }),
};

export default class ExecCommand extends LandoCommandBase {
  static override description = execSpec.summary;
  static override aliases = [...resolveTopLevelAliases(execSpec)];
  static override landoSpec: LandoCommandSpec = execSpec;

  override async run(): Promise<void> {
    await this.runEffect(execSpec);
  }
}
