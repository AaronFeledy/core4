import { type ExecAppResult, execApp } from "../../commands/exec.ts";
/**
 * `lando exec` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const execSpec: LandoCommandSpec<ExecAppResult> = {
  id: "exec",
  summary: "Run a command in a Lando service.",
  bootstrap: "app",
  // Real flag/arg parsing lands when LandoCommandBase.runEffect is wired.
  run: () => execApp({ service: "", command: [] }),
};

export default class ExecCommand extends LandoCommandBase {
  static override description = execSpec.summary;
  static override landoSpec: LandoCommandSpec = execSpec;

  override async run(): Promise<void> {
    await this.runEffect(execSpec);
  }
}
