import { LogLevelSelectionError } from "@lando/sdk/errors";
import { LOG_LEVELS, type LogLevel } from "@lando/sdk/schema";

import { scanLandoFlags } from "./lando-flags";

export const LOG_LEVEL_ENV_VAR = "LANDO_LOG_LEVEL" as const;
export const DEFAULT_LOG_LEVEL: LogLevel = "none";

const ALLOWED_VALUES_DISPLAY = LOG_LEVELS.join(", ");
const REMEDIATION = `Use --log-level=<value> where <value> is one of: ${ALLOWED_VALUES_DISPLAY}.`;

export const isLogLevel = (value: string): value is LogLevel => LOG_LEVELS.some((level) => level === value);

const validate = (value: string, source: "flag" | "env" | "config"): LogLevel => {
  if (isLogLevel(value)) return value;
  throw new LogLevelSelectionError({
    message: `Unsupported log level value "${value}" from ${source}. Allowed: ${ALLOWED_VALUES_DISPLAY}.`,
    value,
    source,
    remediation: REMEDIATION,
  });
};

const missingLogLevelValueError = (): LogLevelSelectionError =>
  new LogLevelSelectionError({
    message: `--log-level requires a value (one of: ${ALLOWED_VALUES_DISPLAY}).`,
    value: "",
    source: "flag",
    remediation: REMEDIATION,
  });

export type ExtractLogLevelFlagsResult = {
  readonly level?: LogLevel;
  readonly debug: boolean;
  readonly verbose: boolean;
  readonly remainingArgv: ReadonlyArray<string>;
};

export const extractLogLevelFlags = (argv: ReadonlyArray<string>): ExtractLogLevelFlagsResult => {
  let level: LogLevel | undefined;
  let debug = false;
  let verbose = false;
  const remaining = scanLandoFlags(argv, {
    "--debug": () => {
      debug = true;
    },
    "--verbose": () => {
      verbose = true;
    },
    "--log-level": (match) => {
      const value = match.value;
      if (value === undefined || (match.attached && value === "")) throw missingLogLevelValueError();
      level = validate(value, "flag");
    },
  });

  return level === undefined
    ? { debug, verbose, remainingArgv: remaining }
    : { level, debug, verbose, remainingArgv: remaining };
};

export type ResolveLogLevelOptions = {
  readonly argv?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configValue?: string | undefined;
};

export type ResolveLogLevelResult = {
  readonly level: LogLevel;
  readonly verbose: boolean;
  readonly remainingArgv: ReadonlyArray<string>;
  readonly source: "flag" | "env" | "config" | "default";
};

export const resolveLogLevel = (options: ResolveLogLevelOptions = {}): ResolveLogLevelResult => {
  const flagResult = extractLogLevelFlags(options.argv ?? []);
  const verbose = flagResult.debug || flagResult.verbose;

  if (flagResult.level !== undefined) {
    return { level: flagResult.level, verbose, remainingArgv: flagResult.remainingArgv, source: "flag" };
  }
  if (flagResult.debug) {
    return { level: "debug", verbose, remainingArgv: flagResult.remainingArgv, source: "flag" };
  }

  const envLogLevel = options.env?.[LOG_LEVEL_ENV_VAR];
  if (envLogLevel !== undefined && envLogLevel !== "") {
    return {
      level: validate(envLogLevel, "env"),
      verbose,
      remainingArgv: flagResult.remainingArgv,
      source: "env",
    };
  }

  const configValue = options.configValue;
  if (configValue !== undefined && isLogLevel(configValue)) {
    return {
      level: validate(configValue, "config"),
      verbose,
      remainingArgv: flagResult.remainingArgv,
      source: "config",
    };
  }

  return {
    level: DEFAULT_LOG_LEVEL,
    verbose,
    remainingArgv: flagResult.remainingArgv,
    source: verbose ? "flag" : "default",
  };
};
