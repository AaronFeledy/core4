import { Flags } from "@oclif/core";

import { RendererSelectionError } from "@lando/sdk/errors";

import type { RendererMode } from "./renderer-selection.ts";

export const RESULT_FORMATS = ["text", "json", "table", "yaml", "ndjson"] as const;
export type ResultFormat = (typeof RESULT_FORMATS)[number];
export const DEFAULT_RESULT_FORMAT: ResultFormat = "text";

const ALLOWED_VALUES_DISPLAY = RESULT_FORMATS.join(", ");
const REMEDIATION = `Use --format=<value> where <value> is one of: ${ALLOWED_VALUES_DISPLAY}. Use --json or -j as a shortcut for --format=json.`;

export const isResultFormat = (value: string): value is ResultFormat =>
  (RESULT_FORMATS as ReadonlyArray<string>).includes(value);

const validate = (value: string): ResultFormat => {
  if (isResultFormat(value)) return value;
  throw new RendererSelectionError({
    message: `Unsupported result format value "${value}" from flag. Allowed: ${ALLOWED_VALUES_DISPLAY}.`,
    value,
    source: "flag",
    remediation: REMEDIATION,
  });
};

const missingFormatValueError = (): RendererSelectionError =>
  new RendererSelectionError({
    message: `--format requires a value (one of: ${ALLOWED_VALUES_DISPLAY}).`,
    value: "",
    source: "flag",
    remediation: REMEDIATION,
  });

export interface ExtractFormatFlagsResult {
  readonly format?: ResultFormat;
  readonly json: boolean;
  readonly remainingArgv: ReadonlyArray<string>;
}

const FORMAT_LONG_FLAG = "--format";
const FORMAT_EQ_PREFIX = `${FORMAT_LONG_FLAG}=`;

export const extractFormatFlags = (argv: ReadonlyArray<string>): ExtractFormatFlagsResult => {
  let format: ResultFormat | undefined;
  let json = false;
  const remaining: string[] = [];
  let afterDoubleDash = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;

    if (afterDoubleDash) {
      remaining.push(arg);
      continue;
    }
    if (arg === "--") {
      afterDoubleDash = true;
      remaining.push(arg);
      continue;
    }

    if (arg === "--json" || arg === "-j") {
      json = true;
      continue;
    }

    if (arg === FORMAT_LONG_FLAG) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) throw missingFormatValueError();
      format = validate(next);
      index += 1;
      continue;
    }

    if (arg.startsWith(FORMAT_EQ_PREFIX)) {
      const value = arg.slice(FORMAT_EQ_PREFIX.length);
      if (value === "") throw missingFormatValueError();
      format = validate(value);
      continue;
    }

    remaining.push(arg);
  }

  return format === undefined
    ? { json, remainingArgv: remaining }
    : { format, json, remainingArgv: remaining };
};

export interface ResolveResultFormatOptions {
  readonly argv?: ReadonlyArray<string>;
  readonly rendererMode?: RendererMode;
  readonly defaultFormat?: ResultFormat;
}

export interface ResolveResultFormatResult {
  readonly format: ResultFormat;
  readonly remainingArgv: ReadonlyArray<string>;
  readonly source: "format" | "json" | "renderer" | "default";
}

export const resolveResultFormat = (options: ResolveResultFormatOptions = {}): ResolveResultFormatResult => {
  const flagResult = extractFormatFlags(options.argv ?? []);
  if (flagResult.format !== undefined) {
    return { format: flagResult.format, remainingArgv: flagResult.remainingArgv, source: "format" };
  }
  if (flagResult.json) {
    return { format: "json", remainingArgv: flagResult.remainingArgv, source: "json" };
  }
  if (options.rendererMode === "json") {
    return { format: "json", remainingArgv: flagResult.remainingArgv, source: "renderer" };
  }
  return {
    format: options.defaultFormat ?? DEFAULT_RESULT_FORMAT,
    remainingArgv: flagResult.remainingArgv,
    source: "default",
  };
};

export const universalFormatFlagDefs = {
  format: Flags.string({
    description: "Output format.",
    options: [...RESULT_FORMATS],
  }),
  json: Flags.boolean({
    char: "j",
    description: "Shortcut for --format=json.",
  }),
} as const;
