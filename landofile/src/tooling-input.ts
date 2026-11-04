import { ToolingInputError } from "@lando/sdk/errors";
import type {
  ToolingInputDeclaration,
  ToolingInputRevision,
  ToolingInputValues,
  ToolingInvocationInput,
} from "@lando/sdk/schema";
import { Result } from "effect";
import type { ToolingServiceRef } from "./tooling-normalize.ts";

export interface ToolingInputSubject {
  readonly name: string;
  readonly source?: { readonly path: string; readonly task: string };
}

export const toolingInputError = (
  subject: ToolingInputSubject,
  message: string,
  field?: string,
): ToolingInputError =>
  new ToolingInputError({
    message,
    tool: subject.name,
    ...(field === undefined ? {} : { field }),
    ...(subject.source === undefined ? {} : { source: subject.source }),
    remediation: `Check the declared inputs for lando ${subject.name}. If metadata changed, run lando app:cache:refresh and reconnect or re-resolve the command catalog.`,
  });

export const validateToolingInputRevision = (
  subject: ToolingInputSubject,
  declaration: ToolingInputDeclaration,
  expectedInputRevision?: ToolingInputRevision,
): Result.Result<void, ToolingInputError> =>
  expectedInputRevision === undefined || declaration.revision === expectedInputRevision
    ? Result.succeed(undefined)
    : Result.fail(toolingInputError(subject, `Tooling input declarations changed for ${subject.name}.`));

const ownValue = (values: Readonly<Record<string, unknown>>, name: string): unknown =>
  Object.hasOwn(values, name) ? values[name] : undefined;

const readRawInput = (
  subject: ToolingInputSubject,
  declaration: ToolingInputDeclaration,
  argv: readonly string[],
): Result.Result<
  { readonly flags: Readonly<Record<string, unknown>>; readonly args: Readonly<Record<string, unknown>> },
  ToolingInputError
> => {
  const fail = (message: string, field?: string) => Result.fail(toolingInputError(subject, message, field));
  const flags = new Map<string, unknown>();
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
    const flag = declaration.flags.find((candidate) =>
      long ? candidate.name === key : candidate.alias === key,
    );
    if (flag === undefined) return fail("Unknown tooling flag.");
    if (flag.boolean) {
      const value = equals < 0 ? "true" : option.slice(equals + 1);
      if (value !== "true" && value !== "false")
        return fail(`Boolean flag ${flag.name} needs true or false.`, flag.name);
      flags.set(flag.name, value === "true");
      continue;
    }
    const value = equals >= 0 ? option.slice(equals + 1) : argv[index + 1];
    if (value === undefined || (equals < 0 && value.startsWith("-") && value !== "-"))
      return fail(`Flag ${flag.name} needs a value.`, flag.name);
    flags.set(flag.name, value);
    if (equals < 0) index++;
  }
  if (!declaration.acceptsArguments && positionals.length > 0)
    return fail("Tooling command does not accept positional arguments.");
  if (positionals.length > declaration.args.length) return fail("Too many positional arguments.");
  return Result.succeed({
    flags: Object.fromEntries(flags),
    args: Object.fromEntries(
      declaration.args.flatMap((arg, index) => {
        const value = positionals[index];
        return value === undefined ? [] : [[arg.name, value]];
      }),
    ),
  });
};

export const bindToolingInput = (
  subject: ToolingInputSubject,
  declaration: ToolingInputDeclaration,
  invocation: ToolingInvocationInput,
): Result.Result<ToolingInputValues, ToolingInputError> => {
  const fail = (message: string, field?: string) => Result.fail(toolingInputError(subject, message, field));
  const declared = declaration.flags.length + declaration.args.length > 0;
  let supplied: {
    readonly flags: Readonly<Record<string, unknown>>;
    readonly args: Readonly<Record<string, unknown>>;
  };
  switch (invocation._tag) {
    case "RawArgv": {
      if (!declared) {
        if (!declaration.acceptsArguments && invocation.argv.length > 0)
          return fail("Tooling command does not accept arguments.");
        return Result.succeed({ flags: {}, args: {} });
      }
      const parsed = readRawInput(subject, declaration, invocation.argv);
      if (Result.isFailure(parsed)) return Result.fail(parsed.failure);
      supplied = parsed.success;
      break;
    }
    case "NamedMaps":
      if (
        (invocation.passthroughArgv?.length ?? 0) > 0 &&
        (declared || Object.keys(invocation.args).length > 0)
      )
        return fail("Named declared inputs cannot be mixed with a raw argument tail.");
      if (
        !declaration.acceptsArguments &&
        (Object.keys(invocation.args).length > 0 || (invocation.passthroughArgv?.length ?? 0) > 0)
      )
        return fail("Tooling command does not accept positional arguments.");
      supplied = invocation;
      break;
    default:
      return invocation satisfies never;
  }
  if (Object.keys(supplied.flags).some((key) => !declaration.flags.some((flag) => flag.name === key)))
    return fail("Unknown named tooling flag.");
  if (Object.keys(supplied.args).some((key) => !declaration.args.some((arg) => arg.name === key)))
    return fail("Unknown named tooling argument.");
  const flags = new Map<string, string | boolean>();
  const args = new Map<string, string>();
  for (const flag of declaration.flags) {
    const value = Object.hasOwn(supplied.flags, flag.name) ? supplied.flags[flag.name] : flag.default;
    if (value === undefined) {
      if (Object.hasOwn(supplied.flags, flag.name))
        return fail(`Invalid type for flag ${flag.name}.`, flag.name);
      if (flag.required) return fail(`Missing required flag ${flag.name}.`, flag.name);
      continue;
    }
    if (flag.boolean ? typeof value !== "boolean" : typeof value !== "string")
      return fail(`Invalid type for flag ${flag.name}.`, flag.name);
    if (typeof value !== "string" && typeof value !== "boolean")
      return fail(`Invalid type for flag ${flag.name}.`, flag.name);
    if (flag.choices !== undefined && (typeof value !== "string" || !flag.choices.includes(value)))
      return fail(`Flag ${flag.name} must match a declared choice.`, flag.name);
    flags.set(flag.name, value);
  }
  for (const arg of declaration.args) {
    const value = Object.hasOwn(supplied.args, arg.name) ? supplied.args[arg.name] : arg.default;
    if (value === undefined) {
      if (Object.hasOwn(supplied.args, arg.name))
        return fail(`Invalid type for argument ${arg.name}.`, arg.name);
      if (arg.required) return fail(`Missing required argument ${arg.name}.`, arg.name);
      continue;
    }
    if (typeof value !== "string") return fail(`Invalid type for argument ${arg.name}.`, arg.name);
    if (arg.choices !== undefined && !arg.choices.includes(value))
      return fail(`Argument ${arg.name} must match a declared choice.`, arg.name);
    args.set(arg.name, value);
  }
  return Result.succeed({ flags: Object.fromEntries(flags), args: Object.fromEntries(args) });
};

export const lowerToolingInput = (
  subject: ToolingInputSubject,
  declaration: ToolingInputDeclaration,
  values: ToolingInputValues,
): Result.Result<readonly string[], ToolingInputError> => {
  const argv = declaration.flags.flatMap((flag) => {
    const value = ownValue(values.flags, flag.name);
    return typeof value === "string" ? [`--${flag.name}=${value}`] : value === true ? [`--${flag.name}`] : [];
  });
  const positionals: string[] = [];
  let omitted: string | undefined;
  for (const arg of declaration.args) {
    const value = ownValue(values.args, arg.name);
    if (typeof value !== "string") {
      omitted ??= arg.name;
      continue;
    }
    if (omitted !== undefined)
      return Result.fail(
        toolingInputError(
          subject,
          `Positional argument ${omitted} cannot be omitted before a later value.`,
          omitted,
        ),
      );
    positionals.push(value);
  }
  return Result.succeed([...argv, ...positionals]);
};

export const resolveServiceRef = (
  ref: ToolingServiceRef | undefined,
  values: ToolingInputValues,
  task?: ToolingInputSubject,
): Result.Result<string | undefined, ToolingInputError> => {
  if (ref === undefined) return Result.succeed(undefined);
  switch (ref.kind) {
    case "host":
      return Result.succeed(":host");
    case "service":
      return Result.succeed(ref.name);
    case "flag": {
      const value = ownValue(values.flags, ref.flag);
      return typeof value === "string" && value.length > 0 && !value.startsWith(":")
        ? Result.succeed(value)
        : Result.fail(
            toolingInputError(
              task ?? { name: ref.flag },
              `Service flag ${ref.flag} needs a non-empty service name without a leading colon.`,
              ref.flag,
            ),
          );
    }
    default:
      return ref satisfies never;
  }
};
