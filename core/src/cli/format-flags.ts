import { Flags } from "./spec/metadata";

import { RendererSelectionError } from "@lando/sdk/errors";

import type { RendererMode } from "./renderer-selection";

export const RESULT_FORMATS = ["text", "json", "table", "yaml", "ndjson"] as const;
export type ResultFormat = (typeof RESULT_FORMATS)[number];
export const DEFAULT_RESULT_FORMAT: ResultFormat = "text";

/**
 * Formats every command honors: `text` is its human render, and `json` and
 * `yaml` are the boundary's own serializations of the result envelope. They
 * need no declaration and a command cannot narrow them away.
 */
export const UNIVERSAL_RESULT_FORMATS = ["text", "json", "yaml"] as const;

/**
 * Formats a command must declare before it may be asked for one. Both come
 * from a command's own `render`, so a command that does not implement them has
 * nothing to emit and must refuse rather than quietly fall back to text.
 */
export const OPT_IN_RESULT_FORMATS = ["table", "ndjson"] as const;
export type OptInResultFormat = (typeof OPT_IN_RESULT_FORMATS)[number];

/** The capability slice of a command spec that decides its advertised formats. */
export interface ResultFormatCapability {
  readonly resultFormats?: ReadonlyArray<OptInResultFormat>;
}

/** Every format `commandId` honors: the universal set plus whatever it declares. */
export const commandResultFormats = (command?: ResultFormatCapability): ReadonlyArray<ResultFormat> => [
  ...UNIVERSAL_RESULT_FORMATS,
  ...(command?.resultFormats ?? []),
];

export const supportsResultFormat = (
  command: ResultFormatCapability | undefined,
  format: ResultFormat,
): boolean => commandResultFormats(command).includes(format);

export type JsonControl =
  | { readonly mode: "off" }
  | { readonly mode: "list" }
  | { readonly mode: "keys"; readonly keys: readonly string[] };

export const JSON_CONTROL_OFF: JsonControl = { mode: "off" };

const ALLOWED_VALUES_DISPLAY = RESULT_FORMATS.join(", ");
const REMEDIATION = `Use --format=<value> where <value> is one of: ${ALLOWED_VALUES_DISPLAY}. Use --json or -j as a shortcut for --format=json.`;

// Equals form `--json=echo` is always a field list. Space form `--json <token>`
// is consumed only when the token matches this pattern AND contains `,` or `.`.
// A single bare identifier (`echo`) stays positional so `lando exec --json echo`
// does not steal the command; use `--json=app` for a one-key projection.
export const JSON_FIELD_LIST = /^[A-Za-z_][\w.-]*(,[A-Za-z_][\w.-]*)*$/;

export const isResultFormat = (value: string): value is ResultFormat =>
  (RESULT_FORMATS as ReadonlyArray<string>).includes(value);

/**
 * Formats the command boundary serializes from the result envelope itself.
 * Everything else reaches the command's own `render`. Commands that decide
 * "am I producing machine output?" must ask this, not compare against `json`.
 */
export const isEnvelopeResultFormat = (value: ResultFormat | string | undefined): value is "json" | "yaml" =>
  value === "json" || value === "yaml";

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

const missingJqValueError = (): RendererSelectionError =>
  new RendererSelectionError({
    message: "--jq requires a value.",
    value: "",
    source: "flag",
    remediation: REMEDIATION,
  });

export const parseJsonFieldList = (raw: string): readonly string[] => {
  const fields = raw.split(",").map((segment) => segment.trim());
  if (fields.some((field) => field === "")) {
    throw new RendererSelectionError({
      message: `Invalid --json field list "${raw}".`,
      value: raw,
      source: "flag",
      remediation: REMEDIATION,
    });
  }
  return fields;
};

const isSpaceFormJsonFieldList = (token: string): boolean =>
  !token.startsWith("-") && JSON_FIELD_LIST.test(token) && (token.includes(",") || token.includes("."));

export interface ExtractFormatFlagsResult {
  readonly format?: ResultFormat;
  readonly json: boolean;
  readonly jsonFields?: readonly string[];
  readonly jsonList: boolean;
  readonly jq?: string;
  readonly remainingArgv: ReadonlyArray<string>;
}

const FORMAT_LONG_FLAG = "--format";
const FORMAT_EQ_PREFIX = `${FORMAT_LONG_FLAG}=`;
const JSON_LONG_FLAG = "--json";
const JSON_EQ_PREFIX = `${JSON_LONG_FLAG}=`;
const JQ_LONG_FLAG = "--jq";
const JQ_EQ_PREFIX = `${JQ_LONG_FLAG}=`;

export const extractFormatFlags = (argv: ReadonlyArray<string>): ExtractFormatFlagsResult => {
  let format: ResultFormat | undefined;
  let json = false;
  let jsonList = false;
  let jsonFields: readonly string[] | undefined;
  let jq: string | undefined;
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

    if (arg === "-j") {
      json = true;
      continue;
    }

    if (arg === JSON_LONG_FLAG) {
      json = true;
      const next = argv[index + 1];
      if (next !== undefined && isSpaceFormJsonFieldList(next)) {
        jsonList = false;
        jsonFields = parseJsonFieldList(next);
        index += 1;
      } else {
        jsonList = true;
        jsonFields = undefined;
      }
      continue;
    }

    if (arg.startsWith(JSON_EQ_PREFIX)) {
      json = true;
      jsonList = false;
      jsonFields = parseJsonFieldList(arg.slice(JSON_EQ_PREFIX.length));
      continue;
    }

    if (arg === JQ_LONG_FLAG) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) throw missingJqValueError();
      jq = next;
      json = true;
      index += 1;
      continue;
    }

    if (arg.startsWith(JQ_EQ_PREFIX)) {
      const value = arg.slice(JQ_EQ_PREFIX.length);
      if (value === "") throw missingJqValueError();
      jq = value;
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

  return {
    json,
    jsonList,
    remainingArgv: remaining,
    ...(format === undefined ? {} : { format }),
    ...(jsonFields === undefined ? {} : { jsonFields }),
    ...(jq === undefined ? {} : { jq }),
  };
};

export const resolveJsonControl = (
  extractResult: ExtractFormatFlagsResult,
  _effectiveFormat: ResultFormat,
): JsonControl => {
  if (extractResult.jsonFields !== undefined) {
    return { mode: "keys", keys: extractResult.jsonFields };
  }
  if (extractResult.jsonList) {
    return { mode: "list" };
  }
  return JSON_CONTROL_OFF;
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
    options: [...UNIVERSAL_RESULT_FORMATS],
  }),
  json: Flags.boolean({
    char: "j",
    description: "Shortcut for --format=json.",
  }),
} as const;

/**
 * The flag-definition shape every advertisement surface reads. Both the CLI's
 * own `FlagDefinition` and the SDK's `ExecutableCommandFlagSpec` satisfy it.
 */
export interface AdvertisedFlagDefinition {
  readonly name?: string;
  readonly description?: string;
  readonly type?: string;
  readonly valueType?: "string" | "integer";
  readonly char?: string;
  readonly aliases?: ReadonlyArray<string>;
  readonly multiple?: boolean;
  readonly options?: ReadonlyArray<string>;
  readonly default?: unknown;
  readonly required?: boolean;
  readonly helpValue?: string;
}

type FormatFlagCarrier = ResultFormatCapability & {
  readonly flags?: Readonly<Record<string, AdvertisedFlagDefinition>> | undefined;
};

/**
 * The flag definitions a command advertises. `format` always carries the
 * command's own resolved option list, so a spec cannot declare a competing one
 * and no surface can offer a value the command would drop. Spreading over the
 * merged record keeps `format` in its original position, which is what keeps
 * the generated manifest and command reference stable.
 */
export const formatFlagDefsForCommand = (
  command: FormatFlagCarrier,
): Readonly<Record<string, AdvertisedFlagDefinition>> => {
  const declared = command.flags?.format;
  const format: AdvertisedFlagDefinition = {
    ...universalFormatFlagDefs.format,
    ...(declared ?? {}),
    options: [...commandResultFormats(command)],
  };
  const merged: Record<string, AdvertisedFlagDefinition> = {
    ...universalFormatFlagDefs,
    ...(command.flags ?? {}),
  };
  return { ...merged, format };
};

export const unsupportedResultFormatError = (input: {
  readonly commandId: string;
  readonly value: ResultFormat;
  readonly supported: ReadonlyArray<ResultFormat>;
}): RendererSelectionError => {
  const allowed = input.supported.join(", ");
  return new RendererSelectionError({
    message: `${input.commandId} does not support result format "${input.value}". Allowed: ${allowed}.`,
    value: input.value,
    source: "flag",
    remediation: `Use --format=<value> where <value> is one of: ${allowed}.`,
  });
};
