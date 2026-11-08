import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { Effect } from "effect";
import { Args, Flags } from "../../spec/metadata";

import { NotImplementedError } from "@lando/sdk/errors";

import { type ExecAppError, type ExecAppServices, execApp } from "@lando/engine/operations/exec";
import { isStdioRendererIO } from "@lando/renderer/io";
import { ExecAppResult, StreamFrame } from "@lando/sdk/schema";
import { CliInvocation } from "../../../runtime/invocation-context";
import { renderExecAppResult } from "../../commands/exec";
import { attachExecHostIo, withInheritedStdinRawMode } from "../../exec-host-io";
import { isEnvelopeResultFormat } from "../../format-flags";
import { serviceLoginShellCommand, withSessionNoHistoryEnv } from "../../service-login-shell";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { extractSpecParsedArgv } from "../../spec/command-boundary";
import { booleanFlag, specFlagsOf, stringFlag } from "../../spec/input-coercion";
import { execInputUsesCliHostIo } from "./exec";

export const sshSpec: LandoCommandSpec<ExecAppResult, ExecAppError | NotImplementedError, ExecAppServices> = {
  resultSchema: ExecAppResult,
  id: "app:ssh",
  helpGroup: "common",
  summary:
    "Open an interactive shell in a Lando service (alias of `exec --tty --interactive` with bash when present, otherwise sh).",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  strict: false,
  usage: "[--service SERVICE] [-- COMMAND...]",
  commandArgvRemediation:
    "Pass the command after --: lando ssh -- echo hi. The Lando 3 -c spelling is not supported; use lando ssh -- sh -c <script> for shell syntax.",
  flags: {
    service: Flags.string({ char: "s", description: "Service to open a shell in." }),
    user: Flags.string({ char: "u", description: "User to run the shell as inside the service." }),
    "no-history": Flags.boolean({
      description: "Do not persist shell or client history for this session.",
    }),
    subsystem: Flags.string({
      description: "SSH subsystem to invoke; not supported.",
    }),
    sidecar: Flags.boolean({
      description: "Open the shell in a per-app SSH sidecar; not supported.",
    }),
  },
  args: {
    command: Args.string({
      name: "command",
      description: "Optional command to run instead of the default shell.",
    }),
  },
  streaming: StreamFrame,
  streamingMode: "live",
  run: Effect.fn("SshCommand.run")(function* (input: unknown) {
    const invocation = yield* CliInvocation;
    const flags = specFlagsOf(input);
    const parsedArgv = extractSpecParsedArgv(input);
    if (stringFlag(flags, "subsystem") !== undefined)
      return yield* Effect.fail(subsystemDeferred("subsystem"));
    if (booleanFlag(flags, "sidecar")) return yield* Effect.fail(subsystemDeferred("sidecar"));
    const format = stringFlag(flags, "format");
    const service = stringFlag(flags, "service");
    const user = stringFlag(flags, "user");
    const envelope = (format !== undefined && isEnvelopeResultFormat(format)) || booleanFlag(flags, "json");
    const signal = extractSpecAbortSignal(input);
    const base = {
      ...(signal === undefined ? {} : { signal }),
      command: serviceLoginShellCommand(parsedArgv),
      ...(booleanFlag(flags, "no-history") ? { env: withSessionNoHistoryEnv({}) } : {}),
      ...(service === undefined ? {} : { service }),
      ...(user === undefined ? {} : { user }),
    };
    if (!execInputUsesCliHostIo(input)) return yield* execApp({ ...base, interactive: false, tty: false });
    if (!isStdioRendererIO(invocation.io))
      return yield* execApp({
        ...base,
        tty: !envelope && invocation.io.stdoutIsTTY === true,
        interactive: !envelope && invocation.io.stdinIsTTY === true,
        ...(invocation.io.stdin === undefined ? {} : { stdinStream: invocation.io.stdin }),
      });
    if (envelope) return yield* execApp(attachExecHostIo({ ...base, interactive: false, tty: false }));
    const interactive = invocation.io.stdinIsTTY === true;
    const attached = attachExecHostIo({ ...base, tty: true, interactive });
    return yield* withInheritedStdinRawMode(attached.tty === true && interactive, execApp(attached));
  }),
  completion: (result) => commandCompletionFromExitCode(result.exitCode),
  render: (result) => renderExecAppResult(result),
};

const subsystemDeferred = (kind: "subsystem" | "sidecar"): NotImplementedError =>
  new NotImplementedError({
    message: `\`lando ssh --${kind}\`: SSH ${kind} is not supported. Default ssh is provider-exec TTY command behavior only.`,
    commandId: "app:ssh",
    remediation:
      "Drop the unsupported flag. `lando ssh` runs the default service login shell (bash when present, otherwise sh) inside the selected service via provider-exec.",
  });
