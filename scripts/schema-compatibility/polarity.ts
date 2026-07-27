import type { SchemaPolarity } from "./model.ts";

/**
 * Deliberately small: only surfaces with an unambiguous author/consumer
 * direction are listed. Every other public SDK schema is strict by default.
 */
export const SCHEMA_POLARITY_BY_ID: Readonly<Record<string, SchemaPolarity>> = {
  AgentEnvConfig: "input",
  GlobalConfig: "input",
  HealthcheckInput: "input",
  KeymapConfig: "input",
  LandofileShape: "input",
  McpConfig: "input",
  NetworkConfig: "input",
  ServiceConfigInput: "input",
  ConfigLintResult: "output",
  DownloadResult: "output",
  LandoEvent: "output",
  ProxyApplyResult: "output",
};

export const schemaPolarity = (schemaId: string): SchemaPolarity =>
  SCHEMA_POLARITY_BY_ID[schemaId] ?? "strict";
