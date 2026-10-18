import { JSON_SCHEMA_NAMES } from "../../sdk/src/schema/json-schema.ts";
import type { SchemaPolarity } from "./model.ts";

/**
 * Deliberately small: only surfaces with an unambiguous author/consumer
 * direction are listed. Every other public SDK schema is strict by default.
 */
export const SCHEMA_POLARITY_BY_ID: Readonly<Record<string, SchemaPolarity>> = {
  ...Object.fromEntries(
    JSON_SCHEMA_NAMES.filter((name) => name.endsWith("ServiceConfig")).map((name) => [name, "input"]),
  ),
  AgentEnvConfig: "input",
  GlobalConfig: "input",
  HealthcheckInput: "input",
  AppMountInput: "input",
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
