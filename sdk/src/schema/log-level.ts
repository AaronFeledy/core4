/**
 * Canonical diagnostic log-level tokens. Config decode accepts any string;
 * resolve-time selection rejects values outside this list.
 */
export const LOG_LEVELS = ["none", "error", "warn", "info", "debug", "trace"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
