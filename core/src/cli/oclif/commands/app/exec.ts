import { Args, Flags } from "@oclif/core";

import { type ExecAppResult, execApp, renderExecAppResult } from "../../../commands/exec.ts";
import { LandoCommandBase, type LandoCommandSpec, resolveTopLevelAliases } from "../../command-base.ts";

interface ExecFlags {
  readonly service?: string;
  readonly user?: string;
  readonly cwd?: string;
}

export const execSpec: LandoCommandSpec<ExecAppResult> = {
  id: "app:exec",
  summary: "Run a command in a Lando service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  run: () => execApp({ command: [] }),
  render: (result) => renderExecAppResult(result as ExecAppResult),
};

export default class ExecCommand extends LandoCommandBase {
  static override description = execSpec.summary;
  static override aliases = [...resolveTopLevelAliases(execSpec)];
  static override strict = false;
  static override flags = {
    service: Flags.string({ char: "s", description: "Service to run the command in." }),
    user: Flags.string({ char: "u", description: "User to run the command as inside the service." }),
    cwd: Flags.string({ description: "Working directory inside the service." }),
  };
  static override args = {
    command: Args.string({ name: "command", description: "Command to run (first positional)." }),
  };
  static override landoSpec: LandoCommandSpec = execSpec;
  static override bootstrap = execSpec.bootstrap;

  override async run(): Promise<void> {
    const parsed = (await this.parse(ExecCommand)) as {
      readonly flags: ExecFlags;
      readonly argv: ReadonlyArray<string>;
    };
    const command = parsed.argv as ReadonlyArray<string>;
    await this.runEffect({
      ...execSpec,
      run: () =>
        execApp({
          command,
          ...(parsed.flags.service === undefined ? {} : { service: parsed.flags.service }),
          ...(parsed.flags.user === undefined ? {} : { user: parsed.flags.user }),
          ...(parsed.flags.cwd === undefined ? {} : { cwd: parsed.flags.cwd }),
        }),
    });
  }
}
