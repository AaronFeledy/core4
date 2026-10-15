import type { ExecAppRuntimeOptions } from "@lando/engine/operations/exec";
import { parseAnswerFlags } from "../prompts/answer-flags";

export interface ScratchRunOptions
  extends Pick<ExecAppRuntimeOptions, "stdinStream" | "tty" | "hostTerminal" | "terminalResize"> {
  readonly command: ReadonlyArray<string>;
  readonly from?: string;
  readonly service?: string;
  readonly mount: boolean;
  readonly answers: Record<string, string>;
  readonly keep: boolean;
  readonly issues: ReadonlyArray<string>;
  readonly signal?: AbortSignal;
  readonly hostIo?: "cli";
  readonly envelopeFormat?: boolean;
}

const VALUE_FLAGS = new Map<string, "from" | "service" | "answer">([
  ["--from", "from"],
  ["--service", "service"],
  ["--answer", "answer"],
]);
const BOOLEAN_FLAGS = new Set(["--no-mount", "--keep"]);

const flagName = (arg: string): string => {
  const equals = arg.indexOf("=");
  return equals === -1 ? arg : arg.slice(0, equals);
};

const scratchRunCommandTailIndex = (argv: ReadonlyArray<string>): number | undefined => {
  let index = 0;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) return undefined;
    if (arg === "--") return index + 1 < argv.length ? index : undefined;
    if (BOOLEAN_FLAGS.has(arg)) {
      index += 1;
      continue;
    }
    const name = flagName(arg);
    if (VALUE_FLAGS.has(name)) {
      if (arg.includes("=")) {
        index += 1;
        continue;
      }
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) return undefined;
      index += 2;
      continue;
    }
    if (arg === "--version" || arg === "-v") return index + 1 < argv.length ? index : undefined;
    if (arg.startsWith("-")) return undefined;
    return index;
  }
  return undefined;
};

export const scratchRunHasCommandTail = (argv: ReadonlyArray<string>): boolean => {
  const index = scratchRunCommandTailIndex(argv);
  if (index === undefined) return false;
  return argv[index] === "--" ? index + 1 < argv.length : true;
};

export const normalizeScratchRunArgvForParsing = (argv: ReadonlyArray<string>): ReadonlyArray<string> => {
  const index = scratchRunCommandTailIndex(argv);
  if (index === undefined || argv[index] === "--") return argv;
  return [...argv.slice(0, index), "--", ...argv.slice(index)];
};

interface MutableParse {
  command: string[];
  from?: string;
  service?: string;
  mount: boolean;
  answerFlags: string[];
  keep: boolean;
  issues: string[];
}

const consumeValueFlag = (
  parse: MutableParse,
  argv: ReadonlyArray<string>,
  index: number,
): number | undefined => {
  const arg = argv[index];
  if (arg === undefined) return undefined;
  const equals = arg.indexOf("=");
  const name = equals === -1 ? arg : arg.slice(0, equals);
  const kind = VALUE_FLAGS.get(name);
  if (kind === undefined) return undefined;
  let value: string | undefined;
  let consumed = 1;
  if (equals !== -1) {
    value = arg.slice(equals + 1);
  } else {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith("-")) {
      parse.issues.push(`Flag ${name} expects a value.`);
      return 1;
    }
    value = next;
    consumed = 2;
  }
  if (kind === "answer") parse.answerFlags.push(value);
  else parse[kind] = value;
  return consumed;
};

export const parseScratchRunArgv = (argv: ReadonlyArray<string>): ScratchRunOptions => {
  const parse: MutableParse = { command: [], mount: true, answerFlags: [], keep: false, issues: [] };
  let index = 0;
  let commandStarted = false;
  while (index < argv.length) {
    const arg = argv[index];
    if (arg === undefined) {
      index += 1;
      continue;
    }
    if (commandStarted) {
      parse.command.push(arg);
      index += 1;
      continue;
    }
    if (arg === "--") {
      commandStarted = true;
      index += 1;
      continue;
    }
    if (arg === "--no-mount") {
      parse.mount = false;
      index += 1;
      continue;
    }
    if (arg === "--keep") {
      parse.keep = true;
      index += 1;
      continue;
    }
    const consumed = consumeValueFlag(parse, argv, index);
    if (consumed !== undefined) {
      index += consumed;
      continue;
    }
    commandStarted = true;
    parse.command.push(arg);
    index += 1;
  }
  return {
    command: parse.command,
    ...(parse.from === undefined ? {} : { from: parse.from }),
    ...(parse.service === undefined ? {} : { service: parse.service }),
    mount: parse.mount,
    answers: parseAnswerFlags(parse.answerFlags),
    keep: parse.keep,
    issues: parse.issues,
  };
};

export const scratchRunOptionsFromInput = (input: unknown): ScratchRunOptions => {
  const record: Record<string, unknown> =
    typeof input === "object" && input !== null ? Object.fromEntries(Object.entries(input)) : {};
  const flags: Record<string, unknown> =
    typeof record.flags === "object" && record.flags !== null
      ? Object.fromEntries(Object.entries(record.flags))
      : {};
  const argv = Array.isArray(record.argv)
    ? record.argv.filter((entry): entry is string => typeof entry === "string")
    : [];
  const parsed = parseScratchRunArgv(argv);
  const answerFlags = Array.isArray(flags.answer)
    ? flags.answer.filter((entry): entry is string => typeof entry === "string")
    : [];
  const signal = record.signal instanceof AbortSignal ? record.signal : undefined;
  return {
    ...parsed,
    ...(typeof flags.from === "string" ? { from: flags.from } : {}),
    ...(typeof flags.service === "string" ? { service: flags.service } : {}),
    mount: flags["no-mount"] === true ? false : parsed.mount,
    answers: { ...parsed.answers, ...parseAnswerFlags(answerFlags) },
    keep: flags.keep === true || parsed.keep,
    ...(signal === undefined ? {} : { signal }),
  };
};
