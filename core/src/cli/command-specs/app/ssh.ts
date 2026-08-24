import { Effect } from "effect";
import { Args, Flags } from "../../spec/metadata";

import { NotImplementedError } from "@lando/sdk/errors";

import { type ExecAppResult, execApp } from "@lando/engine/operations/exec";
import { withOptionalStderrOutput } from "@lando/renderer/output";
import { renderExecAppResult } from "../../commands/exec";
import { EmptyResultSchema, type LandoCommandSpec } from "../../spec/command-base";
import { extractSpecFlags, extractSpecParsedArgv } from "../../spec/command-boundary";

const DEFAULT_SSH_COMMAND: ReadonlyArray<string> = ["sh", "-l"];

export const sshSpec: LandoCommandSpec<ExecAppResult> = {
  resultSchema: EmptyResultSchema,
  id: "app:ssh",
  helpGroup: "common",
  summary: "Open an interactive shell in a Lando service (alias of `exec --tty --interactive sh -l`).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  strict: false,
  flags: {
    service: Flags.string({ char: "s", description: "Service to open a shell in." }),
    user: Flags.string({ char: "u", description: "User to run the shell as inside the service." }),
    subsystem: Flags.string({
      description: "(Beta) SSH subsystem to invoke; rejected in Alpha.",
    }),
    sidecar: Flags.boolean({
      description: "(Beta) Open the shell in a per-app SSH sidecar; rejected in Alpha.",
    }),
  },
  args: {
    command: Args.string({
      name: "command",
      description: "Optional command to run instead of the default shell.",
    }),
  },
  run: (input) => {
    const flags = extractSpecFlags(input);
    const parsedArgv = extractSpecParsedArgv(input);
    if (typeof flags.subsystem === "string") return Effect.fail(subsystemDeferred("subsystem"));
    if (flags.sidecar === true) return Effect.fail(subsystemDeferred("sidecar"));
    return withOptionalStderrOutput(
      execApp({
        command: parsedArgv.length === 0 ? DEFAULT_SSH_COMMAND : parsedArgv,
        interactive: true,
        tty: true,
        ...(typeof flags.service === "string" ? { service: flags.service } : {}),
        ...(typeof flags.user === "string" ? { user: flags.user } : {}),
      }),
    );
  },
  successExitCode: (result) => result.exitCode,
  render: (result) => renderExecAppResult(result as ExecAppResult),
};

const subsystemDeferred = (kind: "subsystem" | "sidecar"): NotImplementedError =>
  new NotImplementedError({
    message: `\`lando ssh --${kind}\`: SSH ${kind} support is deferred to Beta. Alpha \`ssh\` is provider-exec TTY command behavior only.`,
    commandId: "app:ssh",
    remediation:
      "Drop the unsupported flag. Alpha `lando ssh` runs the default service shell (`sh -l`) inside the selected service via provider-exec. SSH sidecar/subsystem support lands in Beta.",
  });
