import { type ExecAppResult, execApp } from "../../commands/exec.ts";
/**
 * `lando ssh` — alias of `lando exec` with default `--interactive --tty`.
 */
import { LandoCommandBase, type LandoCommandSpec } from "../command-base.ts";

export const sshSpec: LandoCommandSpec<ExecAppResult> = {
  id: "ssh",
  summary: "Open an interactive shell in a Lando service.",
  bootstrap: "app",
  run: () => execApp({ service: "", command: ["sh"], interactive: true, tty: true }),
};

export default class SshCommand extends LandoCommandBase {
  static override description = sshSpec.summary;
  static override landoSpec: LandoCommandSpec = sshSpec;

  override async run(): Promise<void> {
    await this.runEffect(sshSpec);
  }
}
