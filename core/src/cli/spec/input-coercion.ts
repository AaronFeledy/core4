import { ServiceName } from "@lando/sdk/schema";
import { DEFAULT_RESULT_FORMAT, type ResultFormat, isResultFormat } from "../format-flags";

export const specFlagsOf = (input: unknown): Record<string, unknown> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("flags" in input) ||
    typeof input.flags !== "object" ||
    input.flags === null ||
    Array.isArray(input.flags)
  )
    return {};
  return Object.fromEntries(Object.entries(input.flags));
};

export const specArgsOf = (input: unknown): Record<string, unknown> => {
  if (
    typeof input !== "object" ||
    input === null ||
    !("args" in input) ||
    typeof input.args !== "object" ||
    input.args === null ||
    Array.isArray(input.args)
  )
    return {};
  return Object.fromEntries(Object.entries(input.args));
};

export const stringFlag = (flags: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const value = flags[key];
  return typeof value === "string" ? value : undefined;
};

export const booleanFlag = (flags: Readonly<Record<string, unknown>>, key: string): boolean =>
  flags[key] === true;

export const stringArrayFlag = (
  flags: Readonly<Record<string, unknown>>,
  key: string,
): ReadonlyArray<string> => {
  const value = flags[key];
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : typeof value === "string"
      ? [value]
      : [];
};

/** Empty names pass through so the operation rejects them instead of widening the selection. */
export const serviceNamesFlag = (flags: Readonly<Record<string, unknown>>): ReadonlyArray<ServiceName> =>
  stringArrayFlag(flags, "service").map((value) => ServiceName.make(value));

/**
 * The result format the dispatcher selected for this invocation. `--format`, `--json`, and `-j`
 * are always the dispatcher's, so no built-in declares a `format` flag of its own: the CLI
 * reinjects its selection as `flags.format`. A host that selects none (event steps, MCP) reads
 * the default, `text`.
 */
export const commandResultFormat = (input: unknown): ResultFormat => {
  const format = specFlagsOf(input).format;
  return typeof format === "string" && isResultFormat(format) ? format : DEFAULT_RESULT_FORMAT;
};

/** {@link commandResultFormat} narrowed to the formats a command's own output distinguishes. */
export const commandResultFormatAmong = <T extends ResultFormat>(
  input: unknown,
  allowed: ReadonlyArray<T>,
  fallback: T,
): T => {
  const format = commandResultFormat(input);
  return allowed.find((value) => value === format) ?? fallback;
};
