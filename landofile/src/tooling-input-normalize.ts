import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { ToolingCompileError } from "@lando/sdk/errors";
import {
  type NormalizedToolingArg,
  type NormalizedToolingFlag,
  type ToolingArgShape,
  type ToolingFlagShape,
  type ToolingInputDeclaration,
  ToolingInputRevision,
} from "@lando/sdk/schema";
import { isSecretEnvName } from "@lando/sdk/secrets";
import { Result } from "effect";

export const normalizeToolingInput = (
  name: string,
  authored: {
    readonly flags?: Readonly<Record<string, ToolingFlagShape>>;
    readonly args?: Readonly<Record<string, ToolingArgShape>>;
    readonly arguments?: false;
  },
  source?: { readonly path: string },
): Result.Result<ToolingInputDeclaration, ToolingCompileError> => {
  const fail = (message: string) =>
    Result.fail(
      new ToolingCompileError({
        tool: name,
        message,
        ...(source === undefined ? {} : { source: { path: source.path, task: name } }),
        remediation: `Correct the input declaration for ${name}: ${message}`,
      }),
    );
  const flags: NormalizedToolingFlag[] = [];
  const entries = Object.entries(authored.flags ?? {});
  const names = new Set(entries.map(([key]) => key));
  const aliases = new Set<string>();
  for (const [key, flag] of entries) {
    const sensitive = flag.sensitive === true || isSecretEnvName(key);
    if (sensitive && (flag.default !== undefined || flag.choices !== undefined))
      return fail(`Sensitive flag ${key} must not declare defaults or choices.`);
    if (flag.alias !== undefined) {
      if (names.has(flag.alias) || aliases.has(flag.alias)) return fail(`Flag alias ${flag.alias} collides.`);
      aliases.add(flag.alias);
    }
    if (flag.required === true && flag.default !== undefined)
      return fail(`Required flag ${key} has a default.`);
    if (flag.boolean === true && flag.choices !== undefined)
      return fail(`Boolean flag ${key} declares choices.`);
    if (
      flag.default !== undefined &&
      flag.choices !== undefined &&
      !flag.choices.includes(String(flag.default))
    )
      return fail(`Default for flag ${key} is outside its choices.`);
    const fields = {
      name: key,
      required: flag.required ?? false,
      ...(flag.alias === undefined ? {} : { alias: flag.alias }),
      ...(flag.description === undefined ? {} : { description: flag.description }),
    };
    if (sensitive) {
      flags.push({ ...fields, sensitive: true, boolean: flag.boolean ?? false });
    } else if (flag.boolean === true) {
      if (flag.default !== undefined && typeof flag.default !== "boolean")
        return fail(`Boolean flag ${key} needs a boolean default.`);
      flags.push({
        ...fields,
        sensitive: false,
        boolean: true,
        ...(flag.default === undefined ? {} : { default: flag.default }),
      });
    } else {
      flags.push({
        ...fields,
        sensitive: false,
        boolean: false,
        ...(flag.choices === undefined ? {} : { choices: [...flag.choices] }),
        ...(flag.default === undefined ? {} : { default: String(flag.default) }),
      });
    }
  }
  const argEntries = Object.entries(authored.args ?? {});
  if (authored.arguments === false && argEntries.length > 0)
    return fail("Positional declarations contradict arguments: false.");
  const ordered = argEntries.some(([, arg]) => arg.order !== undefined);
  if (ordered && argEntries.some(([, arg]) => arg.order === undefined))
    return fail("Every argument must declare order when any argument does.");
  const args: NormalizedToolingArg[] = [];
  const orders = new Set<number>();
  for (const [index, [key, arg]] of argEntries.entries()) {
    const sensitive = arg.sensitive === true || isSecretEnvName(key);
    if (sensitive && (arg.default !== undefined || arg.choices !== undefined))
      return fail(`Sensitive argument ${key} must not declare defaults or choices.`);
    const order = arg.order ?? index;
    if (orders.has(order)) return fail(`Argument order ${order} is duplicated.`);
    orders.add(order);
    if (arg.required === true && arg.default !== undefined)
      return fail(`Required argument ${key} has a default.`);
    if (arg.default !== undefined && arg.choices !== undefined && !arg.choices.includes(String(arg.default)))
      return fail(`Default for argument ${key} is outside its choices.`);
    const fields = {
      name: key,
      order,
      required: arg.required ?? false,
      ...(arg.description === undefined ? {} : { description: arg.description }),
    };
    args.push(
      sensitive
        ? { ...fields, sensitive: true }
        : {
            ...fields,
            sensitive: false,
            ...(arg.choices === undefined ? {} : { choices: [...arg.choices] }),
            ...(arg.default === undefined ? {} : { default: String(arg.default) }),
          },
    );
  }
  args.sort((a, b) => a.order - b.order);
  let optionalSeen = false;
  for (const arg of args) {
    if (optionalSeen && arg.required)
      return fail(`Required argument ${arg.name} follows an optional argument.`);
    optionalSeen ||= !arg.required;
  }
  const acceptsArguments = authored.arguments !== false;
  const revision = ToolingInputRevision.make(
    sha256Hex(
      canonicalJson({
        // Bump for admission/forwarding changes that do not alter declaration fields.
        semanticsVersion: 1,
        flags: flags.map(({ description: _, ...semantic }) => semantic),
        args: args.map(({ description: _, ...semantic }) => semantic),
        acceptsArguments,
      }),
    ),
  );
  return Result.succeed({ flags, args, acceptsArguments, revision });
};
