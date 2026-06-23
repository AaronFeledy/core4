/**
 * Shared answer-source and interactivity-flag parsing for the CLI.
 *
 * One module, imported by both the OCLIF command path and the compiled
 * `run.ts` dispatcher, so `--answer`/`--answers`/`--yes`/`--no-interactive`/
 * `--interactive` and the interactivity gate are parsed identically in source
 * and compiled modes. The scratch `--option` synonym merges into the same
 * answer source via {@link mergeAnswerSources}.
 */
import { readFile } from "node:fs/promises";

import type { PromptMode } from "@lando/sdk/schema";

import { parseAnswerFlags } from "../../recipes/prompts/index.ts";

export { parseAnswerFlags };

/** Flatten repeatable answer flags (e.g. `--answer` + the scratch `--option` synonym) into one list. */
export const mergeAnswerSources = (
  ...sources: ReadonlyArray<ReadonlyArray<string> | undefined>
): ReadonlyArray<string> => sources.flatMap((source) => source ?? []);

/** Merge one or more `key=value` flag lists into a single answers record (later wins). */
export const parseAnswerSources = (
  ...sources: ReadonlyArray<ReadonlyArray<string> | undefined>
): Record<string, string> => parseAnswerFlags(mergeAnswerSources(...sources));

/** Thrown when an `--answers <file>` payload is not a flat JSON object of strings. */
export class AnswersFileError extends Error {
  readonly _tag = "AnswersFileError";
  constructor(message: string) {
    super(message);
    this.name = "AnswersFileError";
  }
}

/** Read an `--answers <file>` payload: a flat JSON object of string values. */
export const readAnswersFile = async (path: string): Promise<Record<string, string>> => {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8")) as unknown;
  } catch (cause) {
    throw new AnswersFileError(
      `Could not read answers file "${path}": ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new AnswersFileError(`Answers file "${path}" must contain a JSON object.`);
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") {
      throw new AnswersFileError(`Answer "${key}" in "${path}" must be a string.`);
    }
    out[key] = value;
  }
  return out;
};

/** Interactivity-determining flags, plus the resolved TTY state of the input stream. */
export interface InteractivityFlags {
  readonly yes?: boolean;
  readonly noInteractive?: boolean;
  readonly interactive?: boolean;
  readonly isTTY?: boolean;
}

/** The resolved interactivity gate shared by every prompting surface. */
export interface InteractivityGate {
  readonly yes: boolean;
  readonly interactive: boolean;
  readonly nonInteractive: boolean;
  readonly mode: PromptMode;
}

/**
 * Compute the interactivity gate. `--interactive` forces interactive,
 * `--no-interactive` forces non-interactive, otherwise `auto` keys off TTY
 * stdin. `--yes` (resolve defaults) is orthogonal and reported separately.
 */
export const resolveInteractivityGate = (flags: InteractivityFlags): InteractivityGate => {
  const mode: PromptMode =
    flags.interactive === true ? "interactive" : flags.noInteractive === true ? "non-interactive" : "auto";
  const interactive =
    mode === "interactive" ? true : mode === "non-interactive" ? false : flags.isTTY === true;
  return { yes: flags.yes === true, interactive, nonInteractive: !interactive, mode };
};

/** The single non-interactivity decision shared by every command-dispatch path. */
export const resolveNonInteractive = (flags: InteractivityFlags): boolean =>
  resolveInteractivityGate(flags).nonInteractive;
