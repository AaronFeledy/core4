import { RendererSelectionError } from "@lando/sdk/errors";
import { scanLandoFlags } from "./lando-flags";
import type { RendererMode } from "./renderer-selection";
import { Flags } from "./spec/metadata";

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
 * Formats a command offers only when it produces them. `table` comes from a
 * command's own `render` and must be declared. `ndjson` is the frame sequence:
 * every command that streams frames offers it (the same frames `json` emits),
 * and a report command may supply its own frames instead (`meta:doctor`).
 * A command that produces neither refuses rather than quietly falling back to text.
 */
export const OPT_IN_RESULT_FORMATS = ["table", "ndjson"] as const;
export type OptInResultFormat = (typeof OPT_IN_RESULT_FORMATS)[number];

/** The capability slice of a command spec that decides its advertised formats. */
export interface ResultFormatCapability {
  /**
   * The command's own render produces a table. `ndjson` is never declared: it is
   * derived from `streaming`/`streamingMode`/`ndjsonReport`.
   */
  readonly rendersTable?: true;
  /** The derived opt-in formats, precomputed on manifest-side objects, which carry no `rendersTable`. */
  readonly advertisedFormats?: ReadonlyArray<OptInResultFormat>;
  /** Frame schema of a command that streams output frames. */
  readonly streaming?: unknown;
  readonly streamingMode?: "live" | ((input: unknown) => "live" | undefined);
  /** Report frames a command supplies for `--format=ndjson` (see `NdjsonReport`). */
  readonly ndjsonReport?: unknown;
}

/** True when the command emits a frame sequence under `--format=json`. */
export const emitsFrames = (command?: ResultFormatCapability): boolean =>
  command?.streaming !== undefined || command?.streamingMode === "live";

/** The opt-in formats a command offers, in canonical order. */
export const advertisedOptInFormats = (command?: ResultFormatCapability): ReadonlyArray<OptInResultFormat> =>
  OPT_IN_RESULT_FORMATS.filter((format) => {
    switch (format) {
      case "table":
        return command?.rendersTable === true || command?.advertisedFormats?.includes("table") === true;
      case "ndjson":
        return (
          command?.advertisedFormats?.includes("ndjson") === true ||
          command?.ndjsonReport !== undefined ||
          emitsFrames(command)
        );
      default:
        return format satisfies never;
    }
  });

/** Every format a command honors: the universal set plus the opt-in formats it produces. */
export const commandResultFormats = (command?: ResultFormatCapability): ReadonlyArray<ResultFormat> => [
  ...UNIVERSAL_RESULT_FORMATS,
  ...advertisedOptInFormats(command),
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

export const isResultFormat = (value: string): value is ResultFormat =>
  (RESULT_FORMATS as ReadonlyArray<string>).includes(value);

/**
 * Formats the command boundary serializes from the result envelope itself.
 * Everything else reaches the command's own `render`. Commands that decide
 * "am I producing machine output?" must ask this, not compare against `json`.
 */
export const isEnvelopeResultFormat = (value: ResultFormat | string | undefined): value is "json" | "yaml" =>
  value === "json" || value === "yaml";

/**
 * Formats whose stdout is read by a program: the envelope formats and the
 * `ndjson` frame sequence. Execution policy (no PTY, collected or framed child
 * output, no human progress) follows this, not the envelope question.
 */
export const isMachineResultFormat = (
  value: ResultFormat | string | undefined,
): value is "json" | "yaml" | "ndjson" => isEnvelopeResultFormat(value) || value === "ndjson";

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

export interface ExtractFormatFlagsResult {
  readonly format?: ResultFormat;
  readonly json: boolean;
  readonly jsonFields?: readonly string[];
  readonly jsonList: boolean;
  readonly jq?: string;
  readonly remainingArgv: ReadonlyArray<string>;
}

export const extractFormatFlags = (argv: ReadonlyArray<string>): ExtractFormatFlagsResult => {
  let format: ResultFormat | undefined;
  let json = false;
  let jsonList = false;
  let jsonFields: readonly string[] | undefined;
  let jq: string | undefined;
  const remaining = scanLandoFlags(argv, {
    "-j": () => {
      json = true;
    },
    "--json": (match) => {
      json = true;
      const value = match.value;
      if (value === undefined) {
        jsonList = true;
        jsonFields = undefined;
        return;
      }
      jsonList = false;
      jsonFields = parseJsonFieldList(value);
    },
    "--jq": (match) => {
      const value = match.value;
      if (value === undefined || (match.attached && value === "")) throw missingJqValueError();
      jq = value;
      json = true;
    },
    "--format": (match) => {
      const value = match.value;
      if (value === undefined || (match.attached && value === "")) throw missingFormatValueError();
      format = validate(value);
    },
  });

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
 * The command-flag names every command already advertises, so text and machine
 * help hide them: the keys of `universalFormatFlagDefs`.
 */
export const UNIVERSAL_FORMAT_FLAG_NAMES: ReadonlySet<string> = new Set(Object.keys(universalFormatFlagDefs));

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
