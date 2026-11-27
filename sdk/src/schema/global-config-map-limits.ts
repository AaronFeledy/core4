import { CORE_SERVICE_ENV_KEYS } from "./generated/core-service-env.ts";

export const APP_DEFAULTS_MAX_PROPERTIES = 256;
export const APP_ENVIRONMENT_KEY = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const NUL = String.fromCharCode(0);
export const APP_LABEL_KEY = new RegExp(`^(?!dev\\.lando\\.)[^${NUL}=]+$`, "u");
export const APP_ENVIRONMENT_VALUE_KIB = 32;
export const APP_ENVIRONMENT_MAP_KIB = 1024;
export const APP_LABEL_KEY_BYTES = 253;
export const APP_LABEL_VALUE_KIB = 4;
export const APP_LABEL_MAP_KIB = 256;

export const globalConfigMapInputs = {
  AppEnvironmentDefaults: {
    propertyNames: { pattern: APP_ENVIRONMENT_KEY.source, not: { enum: CORE_SERVICE_ENV_KEYS } },
    description: `Environment defaults applied below each user-app service's authored environment. The runtime limits each value to ${APP_ENVIRONMENT_VALUE_KIB} KiB of UTF-8 and the serialized JSON map to 1 MiB.`,
  },
  AppLabelDefaults: {
    propertyNames: { pattern: APP_LABEL_KEY.source, maxLength: APP_LABEL_KEY_BYTES },
    description: `Container-label defaults applied below each user-app service's authored labels. The runtime limits keys to ${APP_LABEL_KEY_BYTES} UTF-8 bytes, values to ${APP_LABEL_VALUE_KIB} KiB of UTF-8, and the serialized JSON map to ${APP_LABEL_MAP_KIB} KiB.`,
  },
} as const;
