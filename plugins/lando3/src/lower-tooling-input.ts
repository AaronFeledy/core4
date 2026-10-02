/**
 * Lando 3 yargs `options` and positionals as Lando 4 `flags` and `args`.
 *
 * Lando 4 rejects a default outside the declared choices, a boolean flag with
 * choices or a non-boolean default, and a required input that also has a
 * default, so each such Lando 3 combination drops the part Lando 3 could never
 * have honored and reports it.
 */
import type { Lando3Path } from "./contract.ts";
import { type V4Wire, asStringArray, isPlainObject } from "./lowering-contract.ts";
import { type Report, lowerText } from "./lowering-report.ts";

const POSITIONAL_TOKEN = /\[([^\]\s]+)\]|<([^>\s]+)>/gu;

const isScalar = (value: unknown): value is string | number | boolean =>
  typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const scalarChoices = (value: unknown): ReadonlyArray<string> | undefined =>
  Array.isArray(value) && value.every(isScalar) ? value.map(String) : undefined;

/** Keys shared by flags and args: description, default, choices, and a string `type`. */
const lowerCommonInput = (
  key: string,
  value: unknown,
  out: Record<string, unknown>,
  path: Lando3Path,
  report: Report,
): boolean => {
  switch (key) {
    case "describe":
    case "description": {
      const text = lowerText(value, [...path, key], report);
      if (typeof text === "string") out.description = text;
      return true;
    }
    case "default":
      if (isScalar(value)) out.default = value;
      else
        report(
          "dropped",
          [...path, key],
          "Lando 4 defaults must be a single string, number, or boolean.",
          "Set a scalar default in the generated Landofile.",
        );
      return true;
    case "choices": {
      const choices = scalarChoices(value);
      if (choices !== undefined) out.choices = choices;
      else
        report(
          "dropped",
          [...path, key],
          "Lando 4 choices must be a list of plain values.",
          "List the allowed values as strings.",
        );
      return true;
    }
    case "type":
      if (value !== "string" && value !== "boolean") {
        report(
          "dropped",
          [...path, key],
          `Lando 4 input carries string or boolean values, not ${String(value)}.`,
          "Validate the value inside the command instead.",
        );
      }
      return true;
    default:
      return false;
  }
};

/** Resolves required/default/choices combinations Lando 4 refuses to decode. */
const reconcile = (
  out: Record<string, unknown>,
  spec: Record<string, unknown>,
  path: Lando3Path,
  report: Report,
): void => {
  const choices = asStringArray(out.choices);
  if (out.default !== undefined && choices !== undefined && !choices.includes(String(out.default))) {
    Reflect.deleteProperty(out, "default");
    report(
      "dropped",
      [...path, "default"],
      "The default is not one of the declared choices, which Lando 4 rejects.",
      "Add the default to the choices or pick a listed value.",
    );
  }
  if (out.required === true && out.default !== undefined) {
    Reflect.deleteProperty(out, "required");
    const key = ["demandOption", "required"].find((candidate) => Object.hasOwn(spec, candidate));
    report(
      "dropped",
      key === undefined ? path : [...path, key],
      "Input with a default is never missing, and Lando 4 rejects required with a default.",
      "Keep either the default or the requirement.",
    );
  }
};

export const lowerFlags = (
  options: Record<string, unknown>,
  path: Lando3Path,
  report: Report,
  serviceFlag: { readonly source: string; readonly target: string } | undefined,
): V4Wire | undefined => {
  const flags: Record<string, unknown> = {};
  for (const [name, spec] of Object.entries(options)) {
    const flagPath = [...path, name];
    if (!isPlainObject(spec)) {
      report(
        "dropped",
        flagPath,
        "A Lando 3 option must be a mapping.",
        "Declare the flag by hand in the generated Landofile.",
      );
      continue;
    }
    const out: Record<string, unknown> = {};
    const boolean = spec.boolean === true || spec.type === "boolean";
    if (boolean) out.boolean = true;
    for (const [key, value] of Object.entries(spec)) {
      if (lowerCommonInput(key, value, out, flagPath, report)) continue;
      switch (key) {
        case "alias": {
          const aliases = asStringArray(value) ?? [];
          if (aliases[0] !== undefined) out.alias = aliases[0];
          aliases
            .slice(1)
            .forEach((_alias, index) =>
              report(
                "dropped",
                Array.isArray(value) ? [...flagPath, key, index + 1] : [...flagPath, key],
                "Lando 4 flags take one alias.",
                "Use the first alias or the full flag name.",
              ),
            );
          break;
        }
        case "boolean":
        case "passthrough":
          break;
        case "demandOption":
        case "required":
          if (value === true) out.required = true;
          break;
        case "interactive":
          report(
            "dropped",
            [...flagPath, key],
            "Lando 4 tooling does not prompt for flag values.",
            "Pass the flag on the command line, or give it a default.",
          );
          break;
        default:
          report(
            "dropped",
            [...flagPath, key],
            `${key} has no Lando 4 flag field.`,
            "Remove it, or enforce it inside the command.",
          );
      }
    }
    if (boolean) {
      if (out.choices !== undefined) {
        Reflect.deleteProperty(out, "choices");
        report(
          "dropped",
          [...flagPath, "choices"],
          "Lando 4 boolean flags take no choices.",
          "Remove the choices.",
        );
      }
      if (out.default !== undefined && typeof out.default !== "boolean") {
        Reflect.deleteProperty(out, "default");
        report(
          "dropped",
          [...flagPath, "default"],
          "A Lando 4 boolean flag default must be true or false.",
          "Set default: true or false.",
        );
      }
    }
    reconcile(out, spec, flagPath, report);
    flags[serviceFlag?.source === name ? serviceFlag.target : name] = out;
  }
  if (Object.keys(flags).length === 0) return undefined;
  report(
    "rewritten",
    path,
    "Options became flags. Lando 4 forwards every flag that has a value to the command as --name=value and rejects flags the task does not declare.",
    "Review the flags and how the command reads them.",
  );
  return flags;
};

/**
 * Positionals come from `[name]` / `<name>` tokens in the task key, in that
 * order, then from any `positionals` entries the key does not name.
 */
export const lowerPositionals = (
  tokenText: string,
  positionals: unknown,
  taskPath: Lando3Path,
  report: Report,
): V4Wire | undefined | "invalid" => {
  const tokens = [...tokenText.matchAll(POSITIONAL_TOKEN)].map((token) => ({
    name: (token[1] ?? token[2] ?? "").replace(/\.\.\.?$/u, ""),
    required: token[2] !== undefined,
    variadic: /\.\.\.?$/u.test(token[1] ?? token[2] ?? ""),
  }));
  const specs = isPlainObject(positionals) ? positionals : {};
  const names = [...new Set([...tokens.map(({ name }) => name), ...Object.keys(specs)])];
  if (names.length === 0) return undefined;
  const args: Record<string, unknown> = {};
  let optionalSeen = false;
  for (const [order, name] of names.entries()) {
    const token = tokens.find((candidate) => candidate.name === name);
    const out: Record<string, unknown> = { order };
    if (token?.required === true) {
      if (optionalSeen) {
        report(
          "unsupported",
          taskPath,
          `Required argument ${name} follows an optional one, which Lando 4 rejects.`,
          "Reorder the arguments so required ones come first.",
        );
        return "invalid";
      }
      out.required = true;
    } else optionalSeen = true;
    if (token?.variadic === true) {
      report(
        "dropped",
        taskPath,
        `Argument ${name} accepted several values in Lando 3; Lando 4 args take one value each.`,
        "Pass extra values through a task without declared input, or add more args.",
      );
    }
    const spec = specs[name];
    const specPath = [...taskPath, "positionals", name];
    if (isPlainObject(spec)) {
      for (const [key, value] of Object.entries(spec)) {
        if (!lowerCommonInput(key, value, out, specPath, report)) {
          report(
            "dropped",
            [...specPath, key],
            `${key} has no Lando 4 argument field.`,
            "Remove it, or enforce it inside the command.",
          );
        }
      }
      reconcile(out, spec, specPath, report);
    }
    args[name] = out;
  }
  report(
    "rewritten",
    tokens.length > 0 ? taskPath : [...taskPath, "positionals"],
    "Positional arguments became args. Lando 4 hands them to the command as $1 onward after any declared flags.",
    "Review the args and how the command reads them.",
  );
  return args;
};
