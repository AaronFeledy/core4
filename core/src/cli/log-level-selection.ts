import { LogLevelSelectionError } from "@lando/sdk/errors";
import { LOG_LEVELS, type LogLevel } from "@lando/sdk/schema";

export const LOG_LEVEL_ENV_VAR = "LANDO_LOG_LEVEL" as const;
export const LANDO_DEBUG_ENV_VAR = "LANDO_DEBUG" as const;
export const DEFAULT_LOG_LEVEL: LogLevel = "none";

const ALLOWED_VALUES_DISPLAY = LOG_LEVELS.join(", ");
const REMEDIATION = `Use --log-level=<value> where <value> is one of: ${ALLOWED_VALUES_DISPLAY}.`;

const LOG_LEVEL_LONG_FLAG = "--log-level";
const LOG_LEVEL_EQ_PREFIX = `${LOG_LEVEL_LONG_FLAG}=`;
const DEBUG_LONG_FLAG = "--debug";

export const isLogLevel = (value: string): value is LogLevel => LOG_LEVELS.some((level) => level === value);

export const isLandoDebugEnv = (value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes";
};

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
  readonly remainingArgv: ReadonlyArray<string>;
};

export const extractLogLevelFlags = (argv: ReadonlyArray<string>): ExtractLogLevelFlagsResult => {
  let level: LogLevel | undefined;
  let debug = false;
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

    if (arg === DEBUG_LONG_FLAG) {
      debug = true;
      continue;
    }

    if (arg === LOG_LEVEL_LONG_FLAG) {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) throw missingLogLevelValueError();
      level = validate(next, "flag");
      index += 1;
      continue;
    }

    if (arg.startsWith(LOG_LEVEL_EQ_PREFIX)) {
      const value = arg.slice(LOG_LEVEL_EQ_PREFIX.length);
      if (value === "") throw missingLogLevelValueError();
      level = validate(value, "flag");
      continue;
    }

    remaining.push(arg);
  }

  return level === undefined
    ? { debug, remainingArgv: remaining }
    : { level, debug, remainingArgv: remaining };
};

export type ResolveLogLevelOptions = {
  readonly argv?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configValue?: string | undefined;
};

export type ResolveLogLevelResult = {
  readonly level: LogLevel;
  readonly remainingArgv: ReadonlyArray<string>;
  readonly source: "flag" | "env" | "config" | "default";
};

export const resolveLogLevel = (options: ResolveLogLevelOptions = {}): ResolveLogLevelResult => {
  const flagResult = extractLogLevelFlags(options.argv ?? []);
  if (flagResult.level !== undefined) {
    return { level: flagResult.level, remainingArgv: flagResult.remainingArgv, source: "flag" };
  }
  if (flagResult.debug) {
    return { level: "debug", remainingArgv: flagResult.remainingArgv, source: "flag" };
  }

  const envLogLevel = options.env?.[LOG_LEVEL_ENV_VAR];
  if (envLogLevel !== undefined && envLogLevel !== "") {
    return {
      level: validate(envLogLevel, "env"),
      remainingArgv: flagResult.remainingArgv,
      source: "env",
    };
  }

  const envDebug = options.env?.[LANDO_DEBUG_ENV_VAR];
  if (envDebug !== undefined && isLandoDebugEnv(envDebug)) {
    return {
      level: "debug",
      remainingArgv: flagResult.remainingArgv,
      source: "env",
    };
  }

  const configValue = options.configValue;
  if (configValue !== undefined && configValue !== "") {
    return {
      level: validate(configValue, "config"),
      remainingArgv: flagResult.remainingArgv,
      source: "config",
    };
  }

  return {
    level: DEFAULT_LOG_LEVEL,
    remainingArgv: flagResult.remainingArgv,
    source: "default",
  };
};
