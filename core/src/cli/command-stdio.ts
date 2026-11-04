import { CommandStdioError } from "@lando/sdk/errors";
import type { ExecutableCommandStdio, ExecutableCommandStdioRequest } from "@lando/sdk/plugins";
import { Effect, Stream } from "effect";

import { cancellableTerminalStdin } from "./commands/terminal-stdin";
import type { ResultFormat } from "./format-flags";
import { resolveOutputRouting } from "./output-routing";
import type { RendererMode } from "./renderer-selection";

export type CommandStdioStdin = Parameters<typeof cancellableTerminalStdin>[0] & {
  readonly isTTY?: boolean;
};

export interface GrantCommandStdioOptions {
  readonly command: string;
  readonly request: ExecutableCommandStdioRequest | undefined;
  /** Base `Renderer.output.stdout` captured before the redacted wrapper. */
  readonly baseStdout: (chunk: string | Uint8Array) => Effect.Effect<void>;
  readonly stdoutIsTTY: boolean;
  readonly stdinIsTTY: boolean;
  readonly stdin?: CommandStdioStdin;
  readonly resultFormat: ResultFormat;
  readonly rendererMode: RendererMode;
}

export const commandStdioExitCode = (error: unknown): number | undefined => {
  if (!(error instanceof CommandStdioError)) return undefined;
  return error.reason === "read" ? 1 : 2;
};

const stdoutMachineOutputError = (command: string): CommandStdioError =>
  new CommandStdioError({
    message: `Command ${command} cannot write its data payload when the result format uses stdout for an envelope or frames.`,
    command,
    stream: "stdout",
    reason: "machine-output",
    remediation: "Use --format=text, or write the payload to a file instead of -.",
  });

const stdoutTerminalError = (command: string): CommandStdioError =>
  new CommandStdioError({
    message: `Command ${command} cannot write its data payload to a terminal stdout.`,
    command,
    stream: "stdout",
    reason: "terminal",
    remediation: "Redirect or pipe stdout, for example: lando db:export - > dump.sql",
  });

const stdinTerminalError = (command: string): CommandStdioError =>
  new CommandStdioError({
    message: `Command ${command} cannot read its data payload from a terminal stdin.`,
    command,
    stream: "stdin",
    reason: "terminal",
    remediation: "Pipe or redirect stdin, for example: lando db:import - --yes < dump.sql",
  });

const stdinReadError = (command: string, cause: unknown): CommandStdioError =>
  new CommandStdioError({
    message: `Failed to read stdin for ${command}.`,
    command,
    stream: "stdin",
    reason: "read",
    remediation: "Retry the command or check the stdin source.",
    cause,
  });

export const commandStdioRequestError = (
  options: Omit<GrantCommandStdioOptions, "baseStdout" | "stdin">,
): CommandStdioError | undefined => {
  const request = options.request;
  if (request === undefined || (request.stdin !== true && request.stdout !== true)) {
    return undefined;
  }

  if (request.stdout === true) {
    const routing = resolveOutputRouting({
      rendererMode: options.rendererMode,
      format: options.resultFormat,
      declaresStreaming: false,
      live: false,
    });
    if (routing.stdout === "envelope" || routing.stdout === "frames") {
      return stdoutMachineOutputError(options.command);
    }
    if (options.stdoutIsTTY) {
      return stdoutTerminalError(options.command);
    }
  }

  if (request.stdin === true && options.stdinIsTTY) {
    return stdinTerminalError(options.command);
  }
  return undefined;
};

export const grantCommandStdio = (
  options: GrantCommandStdioOptions,
): Effect.Effect<ExecutableCommandStdio | undefined, CommandStdioError> => {
  const error = commandStdioRequestError(options);
  if (error !== undefined) return Effect.fail(error);
  const request = options.request;
  if (request === undefined || (request.stdin !== true && request.stdout !== true)) {
    return Effect.succeed(undefined);
  }

  const granted: {
    stdin?: NonNullable<ExecutableCommandStdio["stdin"]>;
    stdout?: NonNullable<ExecutableCommandStdio["stdout"]>;
  } = {};

  if (request.stdout === true) {
    const write = options.baseStdout;
    granted.stdout = (chunk: Uint8Array) => write(chunk);
  }

  if (request.stdin === true) {
    const source = options.stdin ?? process.stdin;
    const command = options.command;
    let claimed = false;
    // Suspend so cancellableTerminalStdin attaches only when the stream is pulled. Stdin is one
    // shared byte source, so a second consumer would silently split the payload; refuse it instead.
    granted.stdin = Stream.suspend(() => {
      if (claimed) return Stream.fail(stdinReadError(command, new Error("stdin was already consumed")));
      claimed = true;
      return Stream.fromAsyncIterable(cancellableTerminalStdin(source), (cause) =>
        stdinReadError(command, cause),
      );
    });
  }

  return Effect.succeed(granted);
};
