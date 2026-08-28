import { Args, Flags } from "../../spec/metadata";

import { type ExecAppResult, execApp, execAppRedactionTokens } from "@lando/engine/operations/exec";
import { StreamFrame } from "@lando/sdk/schema";
import { renderExecAppResult } from "../../commands/exec";
import { attachExecHostIo, withInheritedStdinRawMode } from "../../exec-host-io";
import { EmptyResultSchema, type LandoCommandSpec } from "../../spec/command-base";
import { extractSpecFlags, extractSpecParsedArgv } from "../../spec/command-boundary";

export const execSpec: LandoCommandSpec<ExecAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:exec",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Run a command in a Lando service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  strict: false,
  usage: "[SERVICE] -- [COMMAND...]",
  examples: ["lando exec -- echo hello", "lando exec appserver -- echo hello"],
  flags: {
    user: Flags.string({ char: "u", description: "User to run the command as inside the service." }),
    cwd: Flags.string({ description: "Working directory inside the service." }),
  },
  args: {
    command: Args.string({
      name: "command",
      description: "Command argv after `--`. An optional service name may come first.",
    }),
  },
  streaming: StreamFrame,
  streamingMode: "live",
  run: (input) => {
    const flags = extractSpecFlags(input);
    const json = flags.format === "json" || flags.json === true;
    const base = {
      command: extractSpecParsedArgv(input),
      ...(typeof flags.user === "string" ? { user: flags.user } : {}),
      ...(typeof flags.cwd === "string" ? { cwd: flags.cwd } : {}),
    };
    if (json) return execApp({ ...base, tty: false, interactive: false });
    const tty = process.stdout.isTTY === true;
    const interactive = process.stdin.isTTY === true;
    return withInheritedStdinRawMode(
      tty && interactive,
      execApp(attachExecHostIo({ ...base, tty, interactive })),
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
  redactionTokens: execAppRedactionTokens,
  successExitCode: (result) => result.exitCode,
  render: (result) => renderExecAppResult(result as ExecAppResult),
};
