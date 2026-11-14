import { RendererSelectionError } from "@lando/sdk/errors";
import { RENDERER_MODES } from "@lando/sdk/schema";

import { scanLandoFlags } from "./lando-flags";
import {
  deferredRendererFlagError,
  deferredRendererModeError,
  findDeferredRendererFlag,
  isDeferredRendererMode,
} from "./renderer-deferred";

export { RENDERER_MODES };
export type RendererMode = (typeof RENDERER_MODES)[number];
export const DEFAULT_RENDERER_MODE: RendererMode = "lando";
export const RENDERER_ENV_VAR = "LANDO_RENDERER" as const;

const ALLOWED_VALUES_DISPLAY = RENDERER_MODES.join(", ");
const REMEDIATION = `Use --renderer=<value> where <value> is one of: ${ALLOWED_VALUES_DISPLAY}.`;

export const isRendererMode = (value: string): value is RendererMode =>
  (RENDERER_MODES as ReadonlyArray<string>).includes(value);

const validate = (value: string, source: "flag" | "env" | "config"): RendererMode => {
  if (isDeferredRendererMode(value)) {
    throw deferredRendererModeError(value, source);
  }
  if (isRendererMode(value)) return value;
  throw new RendererSelectionError({
    message: `Unsupported renderer value "${value}" from ${source}. Allowed: ${ALLOWED_VALUES_DISPLAY}.`,
    value,
    source,
    remediation: REMEDIATION,
  });
};

export interface ExtractRendererFlagResult {
  readonly mode?: RendererMode;
  readonly remainingArgv: ReadonlyArray<string>;
}

export const extractRendererFlag = (argv: ReadonlyArray<string>): ExtractRendererFlagResult => {
  const deferred = findDeferredRendererFlag(argv);
  if (deferred !== undefined) {
    throw deferredRendererFlagError(deferred);
  }
  let mode: RendererMode | undefined;
  const remaining = scanLandoFlags(argv, {
    "--renderer": (match) => {
      const value = match.value;
      if (value === undefined || (match.attached && value === "")) {
        throw new RendererSelectionError({
          message: `--renderer requires a value (one of: ${ALLOWED_VALUES_DISPLAY}).`,
          value: "",
          source: "flag",
          remediation: REMEDIATION,
        });
      }
      mode = validate(value, "flag");
    },
  });
  return mode === undefined ? { remainingArgv: remaining } : { mode, remainingArgv: remaining };
};

export interface ResolveRendererModeOptions {
  readonly argv?: ReadonlyArray<string>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly configValue?: string | undefined;
  readonly defaultMode?: RendererMode;
}

export interface ResolveRendererModeResult {
  readonly mode: RendererMode;
  readonly remainingArgv: ReadonlyArray<string>;
  readonly source: "flag" | "env" | "config" | "default";
}

export const resolveRendererMode = (options: ResolveRendererModeOptions = {}): ResolveRendererModeResult => {
  const argv = options.argv ?? [];
  const flagResult = extractRendererFlag(argv);
  if (flagResult.mode !== undefined) {
    return { mode: flagResult.mode, remainingArgv: flagResult.remainingArgv, source: "flag" };
  }
  const envValue = options.env?.[RENDERER_ENV_VAR];
  if (envValue !== undefined && envValue !== "") {
    return {
      mode: validate(envValue, "env"),
      remainingArgv: flagResult.remainingArgv,
      source: "env",
    };
  }
  const configValue = options.configValue;
  if (configValue !== undefined && isRendererMode(configValue)) {
    return {
      mode: validate(configValue, "config"),
      remainingArgv: flagResult.remainingArgv,
      source: "config",
    };
  }
  return {
    mode: options.defaultMode ?? DEFAULT_RENDERER_MODE,
    remainingArgv: flagResult.remainingArgv,
    source: "default",
  };
};

export const formatRendererSelectionError = (error: RendererSelectionError): string =>
  `${error._tag}\n${error.message}\n${error.remediation}`;
