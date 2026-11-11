import {
  type ExecAppError,
  type ExecAppServices,
  execApp,
  execAppRedactionTokens,
} from "@lando/engine/operations/exec";
import { isStdioRendererIO } from "@lando/renderer/io";
import { commandCompletionFromExitCode } from "@lando/sdk/command-result";
import { ExecAppResult, StreamFrame } from "@lando/sdk/schema";
import { Effect } from "effect";
import { CliInvocation } from "../../../runtime/invocation-context";
import { wordsBeforeSeparator } from "../../command-tail";
import { renderExecAppResult } from "../../commands/exec";
import { attachExecHostIo, withInheritedStdinRawMode } from "../../exec-host-io";
import { isEnvelopeResultFormat } from "../../format-flags";
import { type LandoCommandSpec, extractSpecAbortSignal } from "../../spec/command-base";
import { extractSpecParsedArgv } from "../../spec/command-boundary";
import { booleanFlag, specArgsOf, specFlagsOf, stringFlag } from "../../spec/input-coercion";
import { Args, Flags } from "../../spec/metadata";

export const execInputUsesCliHostIo = (input: unknown): boolean =>
  typeof input === "object" && input !== null && "hostIo" in input && input.hostIo === "cli";

const execFlags = {
  service: Flags.string({
    char: "s",
    description: "Service to run the command in (default: the primary service).",
  }),
  user: Flags.string({ char: "u", description: "User to run the command as inside the service." }),
  cwd: Flags.string({ description: "Working directory inside the service." }),
  interactive: Flags.boolean({
    char: "i",
    description: "Attach your terminal keyboard to the command. Piped stdin is always attached.",
    default: false,
  }),
};

// The CLI input keeps a `--` the user typed and drops the one Lando inserts before the command tail.
const cliSeparatorAt = (input: unknown): number =>
  wordsBeforeSeparator(
    typeof input === "object" && input !== null && "argv" in input && Array.isArray(input.argv)
      ? input.argv.filter((arg): arg is string => typeof arg === "string")
      : [],
    execFlags,
  );

export const execSpec: LandoCommandSpec<ExecAppResult, ExecAppError, ExecAppServices> = {
  resultSchema: ExecAppResult,
  id: "app:exec",
  helpGroup: "common",
  mcpAllowed: true,
  summary: "Run a command in a Lando service.",
  namespace: "app",
  topLevelAlias: true,
  bootstrap: "app",
  strict: false,
  usage: "[--service SERVICE | SERVICE] -- [COMMAND...]",
  examples: ["lando exec -- echo hello", "lando exec -s db -- psql", "lando exec appserver -- echo hello"],
  flags: execFlags,
  args: {
    command: Args.string({
      name: "command",
      multiple: true,
      description: "Command argv after `--`. An optional service name may come first.",
    }),
  },
  streaming: StreamFrame,
  streamingMode: "live",
  run: Effect.fn("ExecCommand.run")(function* (input: unknown) {
    const invocation = yield* CliInvocation;
    const flags = specFlagsOf(input);
    const format = stringFlag(flags, "format");
    const user = stringFlag(flags, "user");
    const service = stringFlag(flags, "service");
    const cwd = stringFlag(flags, "cwd");
    const parsedArgv = extractSpecParsedArgv(input);
    const namedCommand = specArgsOf(input).command;
    const command =
      parsedArgv.length > 0
        ? parsedArgv
        : Array.isArray(namedCommand)
          ? namedCommand.filter((arg): arg is string => typeof arg === "string")
          : [];
    const envelope = (format !== undefined && isEnvelopeResultFormat(format)) || booleanFlag(flags, "json");
    const signal = extractSpecAbortSignal(input);
    const base = {
      ...(signal === undefined ? {} : { signal }),
      command,
      ...(execInputUsesCliHostIo(input) ? { cliSeparatorAt: cliSeparatorAt(input) } : {}),
      ...(service === undefined ? {} : { service }),
      ...(user === undefined ? {} : { user }),
      ...(cwd === undefined ? {} : { cwd }),
    };
    const nonInteractive =
      typeof input === "object" &&
      input !== null &&
      "interaction" in input &&
      input.interaction === "non-interactive";
    if (!execInputUsesCliHostIo(input) || nonInteractive)
      return yield* execApp({ ...base, tty: false, interactive: false });
    if (!isStdioRendererIO(invocation.io))
      return yield* execApp({
        ...base,
        tty: !envelope && invocation.io.stdoutIsTTY === true,
        interactive: !envelope && booleanFlag(flags, "interactive"),
        ...(invocation.io.stdin === undefined ? {} : { stdinStream: invocation.io.stdin }),
      });
    if (envelope) return yield* execApp(attachExecHostIo({ ...base, tty: false, interactive: false }));
    const interactive = booleanFlag(flags, "interactive");
    const attached = attachExecHostIo({ ...base, tty: invocation.io.stdoutIsTTY === true, interactive });
    return yield* withInheritedStdinRawMode(attached.tty === true && interactive, execApp(attached));
  }),
  streamFrames: (value) => {
    const result = value;
    const frames = [];
    if (result.stdout !== undefined && result.stdout.length > 0)
      frames.push({ _tag: "stdout" as const, service: result.service, chunk: result.stdout });
    if (result.stderr !== undefined && result.stderr.length > 0)
      frames.push({ _tag: "stderr" as const, service: result.service, chunk: result.stderr });
    return frames;
  },
  redactionTokens: execAppRedactionTokens,
  completion: (result) => commandCompletionFromExitCode(result.exitCode),
  render: (result) => renderExecAppResult(result),
};
