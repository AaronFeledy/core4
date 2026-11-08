import type { ExecAppRuntimeOptions } from "@lando/engine/operations/exec";
import { parseAnswerFlags } from "../prompts/answer-flags";
import { extractSpecParsedArgv } from "../spec/command-boundary";
import { extractSpecAbortSignal } from "../spec/command-spec";
import { specArgsOf, specFlagsOf } from "../spec/input-coercion";

export interface ScratchRunOptions
  extends Pick<ExecAppRuntimeOptions, "stdinStream" | "tty" | "hostTerminal" | "terminalResize"> {
  readonly command: ReadonlyArray<string>;
  readonly from?: string;
  readonly service?: string;
  readonly mount: boolean;
  readonly answers: Record<string, string>;
  readonly keep: boolean;
  readonly signal?: AbortSignal;
  readonly hostIo?: "cli";
  readonly envelopeFormat?: boolean;
}

/** Options from the shared CLI parse: declared flags, then the verbatim command tail. */
export const scratchRunOptionsFromInput = (input: unknown): ScratchRunOptions => {
  const flags = specFlagsOf(input);
  const parsedArgv = extractSpecParsedArgv(input);
  const namedCommand = specArgsOf(input).command;
  const answerFlags = Array.isArray(flags.answer)
    ? flags.answer.filter((entry): entry is string => typeof entry === "string")
    : [];
  const signal = extractSpecAbortSignal(input);
  return {
    command:
      parsedArgv.length > 0
        ? parsedArgv
        : Array.isArray(namedCommand)
          ? namedCommand.filter((arg): arg is string => typeof arg === "string")
          : [],
    ...(typeof flags.from === "string" ? { from: flags.from } : {}),
    ...(typeof flags.service === "string" ? { service: flags.service } : {}),
    mount: flags["no-mount"] !== true,
    answers: parseAnswerFlags(answerFlags),
    keep: flags.keep === true,
    ...(signal === undefined ? {} : { signal }),
  };
};
