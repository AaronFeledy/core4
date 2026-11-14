import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import type { ToolingCompileError } from "@lando/sdk/errors";
import {
  type NormalizedToolingArg,
  type NormalizedToolingFlag,
  type ToolingArgShape,
  type ToolingFlagShape,
  type ToolingInputDeclaration,
  ToolingInputRevision,
  type ValidationIssue,
} from "@lando/sdk/schema";
import { isSecretEnvName } from "@lando/sdk/secrets";
import { Result } from "effect";
import { type ToolingInspection, toolingCompileResult } from "./tooling-inspection.ts";

export type { ToolingInspection } from "./tooling-inspection.ts";

export const inspectToolingInput = (authored: {
  readonly flags?: Readonly<Record<string, ToolingFlagShape>>;
  readonly args?: Readonly<Record<string, ToolingArgShape>>;
  readonly arguments?: false;
}): ToolingInspection<ToolingInputDeclaration> => {
  const issues: ValidationIssue[] = [];
  const report = (path: readonly (string | number)[], message: string) => {
    issues.push({ path, message, suggestion: "Correct this input declaration." });
  };
  const flags: NormalizedToolingFlag[] = [];
  const entries = Object.entries(authored.flags ?? {});
  const names = new Set(entries.map(([key]) => key));
  const aliases = new Set<string>();
  for (const [key, flag] of entries) {
    const sensitive = flag.sensitive === true || isSecretEnvName(key);
    for (const field of ["default", "choices"] as const) {
      if (sensitive && flag[field] !== undefined)
        report(["flags", key, field], `Sensitive flag ${key} must not declare defaults or choices.`);
    }
    if (flag.alias !== undefined) {
      if (names.has(flag.alias) || aliases.has(flag.alias))
        report(["flags", key, "alias"], "Flag alias collides with another flag name or alias.");
      aliases.add(flag.alias);
    }
    if (flag.required === true && flag.default !== undefined)
      report(["flags", key, "default"], `Required flag ${key} has a default.`);
    if (flag.boolean === true && flag.choices !== undefined)
      report(["flags", key, "choices"], `Boolean flag ${key} declares choices.`);
    if (
      flag.default !== undefined &&
      flag.choices !== undefined &&
      !flag.choices.includes(String(flag.default))
    )
      report(["flags", key, "default"], `Default for flag ${key} is outside its choices.`);
    const fields = {
      name: key,
      required: flag.required ?? false,
      ...(flag.alias === undefined ? {} : { alias: flag.alias }),
      ...(flag.description === undefined ? {} : { description: flag.description }),
    };
    if (sensitive) {
      flags.push({ ...fields, sensitive: true, boolean: flag.boolean ?? false });
    } else if (flag.boolean === true) {
      if (flag.default !== undefined && typeof flag.default !== "boolean") {
        report(["flags", key, "default"], `Boolean flag ${key} needs a boolean default.`);
        continue;
      }
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
    report(["arguments"], "Positional declarations contradict arguments: false.");
  const ordered = argEntries.some(([, arg]) => arg.order !== undefined);
  const completeOrder = !ordered || argEntries.every(([, arg]) => arg.order !== undefined);
  const args: NormalizedToolingArg[] = [];
  const orders = new Set<number>();
  for (const [index, [key, arg]] of argEntries.entries()) {
    const sensitive = arg.sensitive === true || isSecretEnvName(key);
    for (const field of ["default", "choices"] as const) {
      if (sensitive && arg[field] !== undefined)
        report(["args", key, field], `Sensitive argument ${key} must not declare defaults or choices.`);
    }
    const order = arg.order ?? index;
    if (ordered && arg.order === undefined)
      report(["args", key, "order"], "Every argument must declare order when any argument does.");
    if (arg.order !== undefined) {
      if (orders.has(arg.order)) report(["args", key, "order"], "Argument order is duplicated.");
      orders.add(arg.order);
    }
    if (arg.required === true && arg.default !== undefined)
      report(["args", key, "default"], `Required argument ${key} has a default.`);
    if (arg.default !== undefined && arg.choices !== undefined && !arg.choices.includes(String(arg.default)))
      report(["args", key, "default"], `Default for argument ${key} is outside its choices.`);
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
  for (const arg of completeOrder && (!ordered || orders.size === args.length) ? args : []) {
    if (optionalSeen && arg.required)
      report(["args", arg.name, "order"], `Required argument ${arg.name} follows an optional argument.`);
    optionalSeen ||= !arg.required;
  }
  const acceptsArguments = authored.arguments !== false;
  const [first, ...rest] = issues;
  if (first !== undefined) return Result.fail([first, ...rest]);
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

export const normalizeToolingInput = (
  name: string,
  authored: Parameters<typeof inspectToolingInput>[0],
  source?: { readonly path: string },
): Result.Result<ToolingInputDeclaration, ToolingCompileError> =>
  toolingCompileResult(name, inspectToolingInput(authored), source);
