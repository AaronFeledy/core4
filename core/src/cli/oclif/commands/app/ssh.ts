import { type ExecAppResult, execApp } from "../../../commands/exec.ts";
/**
 * `lando app:ssh` — OCLIF wrapper.
 */
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

export const sshSpec: LandoCommandSpec<ExecAppResult> = {
  id: "app:ssh",
  summary: "Open an interactive shell in a Lando service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => execApp({ service: "", command: ["sh"], interactive: true, tty: true }),
};

export default class SshCommand extends LandoCommandBase {
  static override description = sshSpec.summary;
  static override aliases = [...resolveTopLevelAliases(sshSpec)];
  static override landoSpec: LandoCommandSpec = sshSpec;

  override async run(): Promise<void> {
    await this.runEffect(sshSpec);
  }
}
