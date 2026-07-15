import { Args, Flags } from "@oclif/core";

import { StreamFrame } from "@lando/sdk/schema";
import { type ExecAppResult, execApp, renderExecAppResult } from "../../../commands/exec.ts";
import {
  EmptyResultSchema,
  LandoCommandBase,
  type LandoCommandSpec,
  resolveTopLevelAliases,
} from "../../command-base.ts";
import { extractSpecFlags, extractSpecParsedArgv } from "../../command-boundary.ts";

export const execSpec: LandoCommandSpec<ExecAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:exec",
  mcpAllowed: true,
  summary: "Run a command in a Lando service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  streaming: StreamFrame,
  run: (input) => {
    const flags = extractSpecFlags(input);
    return execApp({
      command: extractSpecParsedArgv(input),
      ...(typeof flags.service === "string" ? { service: flags.service } : {}),
      ...(typeof flags.user === "string" ? { user: flags.user } : {}),
      ...(typeof flags.cwd === "string" ? { cwd: flags.cwd } : {}),
    });
  },
  streamFrames: (value) => {
    const result = value as ExecAppResult;
    const frames = [];
    if (result.stdout.length > 0)
      frames.push({ _tag: "stdout" as const, service: result.service, chunk: result.stdout });
    if (result.stderr.length > 0)
      frames.push({ _tag: "stderr" as const, service: result.service, chunk: result.stderr });
    return frames;
  },
  successExitCode: (result) => result.exitCode,
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
    await this.runEffect(execSpec);
  }
}
