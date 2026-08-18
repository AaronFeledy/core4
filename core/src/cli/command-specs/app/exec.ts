import { Args, Flags } from "../../spec/metadata";

import { type ExecAppResult, execApp } from "@lando/engine/operations/exec";
import { withOptionalStderrOutput } from "@lando/renderer/output";
import { StreamFrame } from "@lando/sdk/schema";
import { renderExecAppResult } from "../../commands/exec";
import { EmptyResultSchema, type LandoCommandSpec } from "../../spec/command-base";
import { extractSpecFlags, extractSpecParsedArgv } from "../../spec/command-boundary";

export const execSpec: LandoCommandSpec<ExecAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:exec",
  mcpAllowed: true,
  summary: "Run a command in a Lando service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  strict: false,
  flags: {
    service: Flags.string({ char: "s", description: "Service to run the command in." }),
    user: Flags.string({ char: "u", description: "User to run the command as inside the service." }),
    cwd: Flags.string({ description: "Working directory inside the service." }),
  },
  args: {
    command: Args.string({ name: "command", description: "Command to run (first positional)." }),
  },
  streaming: StreamFrame,
  run: (input) => {
    const flags = extractSpecFlags(input);
    return withOptionalStderrOutput(
      execApp({
        command: extractSpecParsedArgv(input),
        ...(typeof flags.service === "string" ? { service: flags.service } : {}),
        ...(typeof flags.user === "string" ? { user: flags.user } : {}),
        ...(typeof flags.cwd === "string" ? { cwd: flags.cwd } : {}),
      }),
    );
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
