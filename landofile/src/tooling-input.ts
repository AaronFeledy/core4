import { ToolingInputError } from "@lando/sdk/errors";
import { Either } from "effect";
import type { NormalizedToolingTask, ToolingServiceRef } from "./tooling-normalize.ts";

export interface ToolingInputValues {
  readonly flags: Readonly<Record<string, string | boolean>>;
  readonly args: Readonly<Record<string, string>>;
  readonly argv: readonly string[];
}

export const parseToolingArgv = (
  task: NormalizedToolingTask,
  argv: readonly string[],
): Either.Either<ToolingInputValues, ToolingInputError> => {
  if (!task.hasInput) return Either.right({ flags: {}, args: {}, argv: [...argv] });
  const fail = (message: string, field?: string) =>
    Either.left(
      new ToolingInputError({
        message,
        tool: task.name,
        ...(field === undefined ? {} : { field }),
        ...(task.source === undefined ? {} : { source: task.source }),
        remediation: `Check the declared inputs for lando ${task.name}: ${message}`,
      }),
    );
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
  for (const [index, arg] of task.args.entries()) {
    const value = positionals[index] ?? arg.default;
    if (value === undefined) {
      if (arg.required) return fail(`Missing required argument ${arg.name}.`, arg.name);
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
            new ToolingInputError({
              tool: task?.name ?? ref.flag,
              field: ref.flag,
              message: `Service flag ${ref.flag} needs a non-empty service name without a leading colon.`,
              remediation: `Supply --${ref.flag}=<service> using an app service name, not a colon-prefixed target.`,
              ...(task?.source === undefined ? {} : { source: task.source }),
            }),
          );
    }
    default:
      return ref satisfies never;
  }
};
