import { ToolingInputError } from "@lando/sdk/errors";
import { Either } from "effect";
import type { NormalizedToolingTask, ToolingServiceRef } from "./tooling-normalize.ts";

export interface ToolingInputValues {
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly args: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
}

/** Whose declared inputs a failure is attributed to, so every surface names the same task. */
type ToolingInputSubject = Pick<NormalizedToolingTask, "name" | "source">;

const toolingInputError = (
  subject: ToolingInputSubject,
  message: string,
  field?: string,
  remediation = `Check the declared inputs for lando ${subject.name}: ${message}`,
): ToolingInputError =>
  new ToolingInputError({
    message,
    tool: subject.name,
    ...(field === undefined ? {} : { field }),
    ...(subject.source === undefined ? {} : { source: subject.source }),
    remediation,
  });

/**
 * Every surface reads positionals by declaration index, so a slot that resolves to nothing
 * cannot be written into argv while a later positional carries a value: the later value would
 * answer to this argument's name. Both the serializer and the parser refuse here rather than
 * letting the declaration bind the wrong name.
 */
const omittedPositionalError = (subject: ToolingInputSubject, name: string): ToolingInputError =>
  toolingInputError(
    subject,
    `Positional argument ${name} cannot be omitted because a later positional argument has a value.`,
    name,
    `Supply argument ${name} or change the tooling declaration so no later positional value follows it.`,
  );

const lastFilledSlot = (slots: readonly (string | undefined)[]): number => {
  for (let index = slots.length - 1; index >= 0; index -= 1) if (slots[index] !== undefined) return index;
  return -1;
};

export const serializeToolingInput = (
  declaration: Pick<NormalizedToolingTask, "name" | "flags" | "args" | "source">,
  input: {
    readonly flags: Readonly<Record<string, unknown>>;
    readonly args: Readonly<Record<string, unknown>>;
    /** Tokens the caller never bound to a declared name; they always trail the declared slots. */
    readonly passthroughArgv?: readonly string[];
  },
): Either.Either<readonly string[], ToolingInputError> => {
  const flags = declaration.flags.flatMap((flag) => {
    const value = input.flags[flag.name];
    if (flag.boolean) return value === true ? [`--${flag.name}`] : [];
    return typeof value === "string" ? [`--${flag.name}=${value}`] : [];
  });
  const supplied = declaration.args.map((arg) => {
    const value = input.args[arg.name];
    return typeof value === "string" ? value : undefined;
  });
  // Slots past the last supplied value stay absent so the parser, not the caller, applies defaults.
  const emitted = lastFilledSlot(supplied);
  const positionals: string[] = [];
  for (const [index, arg] of declaration.args.entries()) {
    if (index > emitted) break;
    const value = supplied[index] ?? arg.default;
    if (value === undefined) return Either.left(omittedPositionalError(declaration, arg.name));
    positionals.push(value);
  }
  return Either.right([
    ...flags,
    ...(positionals.length === 0 ? [] : ["--", ...positionals]),
    ...(input.passthroughArgv ?? []),
  ]);
};

export const parseToolingArgv = (
  task: NormalizedToolingTask,
  argv: readonly string[],
): Either.Either<ToolingInputValues, ToolingInputError> => {
  if (!task.hasInput) return Either.right({ flags: {}, args: {}, argv: [...argv] });
  const fail = (message: string, field?: string) => Either.left(toolingInputError(task, message, field));
  const flags = new Map<string, string | boolean>();
  const args = new Map<string, string>();
  const positionals: string[] = [];
  let parsingFlags = true;
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (token === undefined) break;
    if (parsingFlags && token === "--") {
      parsingFlags = false;
      continue;
    }
    if (!parsingFlags || !token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }
    const long = token.startsWith("--");
    const option = token.slice(long ? 2 : 1);
    const equals = option.indexOf("=");
    const key = equals < 0 ? option : option.slice(0, equals);
    const flag = task.flags.find((candidate) => (long ? candidate.name === key : candidate.alias === key));
    if (flag === undefined) return fail(`Unknown flag ${key}.`, key);
    if (flag.boolean) {
      if (equals >= 0) return fail(`Boolean flag ${flag.name} takes no value.`, flag.name);
      flags.set(flag.name, true);
      continue;
    }
    const value = equals >= 0 ? option.slice(equals + 1) : argv[index + 1];
    if (value === undefined || (equals < 0 && value.startsWith("-") && value !== "-")) {
      return fail(`Flag ${flag.name} needs a value.`, flag.name);
    }
    if (flag.choices !== undefined && !flag.choices.includes(value))
      return fail(`Flag ${flag.name} must match a declared choice.`, flag.name);
    flags.set(flag.name, value);
    if (equals < 0) index++;
  }
  if (positionals.length > task.args.length) return fail("Too many positional arguments.");
  const canonical: string[] = [];
  for (const flag of task.flags) {
    const value = flags.get(flag.name) ?? flag.default;
    if (value === undefined) {
      if (flag.required) return fail(`Missing required flag ${flag.name}.`, flag.name);
      continue;
    }
    flags.set(flag.name, value);
    if (flag.boolean) {
      if (value === true) canonical.push(`--${flag.name}`);
    } else canonical.push(`--${flag.name}=${value}`);
  }
  const slots = task.args.map((arg, index) => positionals[index] ?? arg.default);
  const resolved = lastFilledSlot(slots);
  for (const [index, arg] of task.args.entries()) {
    const value = slots[index];
    if (value === undefined) {
      if (arg.required) return fail(`Missing required argument ${arg.name}.`, arg.name);
      if (index < resolved) return Either.left(omittedPositionalError(task, arg.name));
      continue;
    }
    if (arg.choices !== undefined && !arg.choices.includes(value))
      return fail(`Argument ${arg.name} must match a declared choice.`, arg.name);
    args.set(arg.name, value);
    canonical.push(value);
  }
  return Either.right({ flags: Object.fromEntries(flags), args: Object.fromEntries(args), argv: canonical });
};

export const resolveServiceRef = (
  ref: ToolingServiceRef | undefined,
  values: ToolingInputValues,
  task?: Pick<NormalizedToolingTask, "name" | "source">,
): Either.Either<string | undefined, ToolingInputError> => {
  if (ref === undefined) return Either.right(undefined);
  switch (ref.kind) {
    case "host":
      return Either.right(":host");
    case "service":
      return Either.right(ref.name);
    case "flag": {
      const value = Object.hasOwn(values.flags, ref.flag) ? values.flags[ref.flag] : undefined;
      return typeof value === "string" && value.length > 0 && !value.startsWith(":")
        ? Either.right(value)
        : Either.left(
            toolingInputError(
              {
                name: task?.name ?? ref.flag,
                ...(task?.source === undefined ? {} : { source: task.source }),
              },
              `Service flag ${ref.flag} needs a non-empty service name without a leading colon.`,
              ref.flag,
              `Supply --${ref.flag}=<service> using an app service name, not a colon-prefixed target.`,
            ),
          );
    }
    default:
      return ref satisfies never;
  }
};
