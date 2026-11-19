import { ConfigKeyNotFoundError } from "@lando/sdk/errors";
import {
  ConfigKeyDescription,
  type ValidationIssuePath,
  describeJsonSchemaPath,
  formatValidationIssuePath,
  getJsonSchema,
} from "@lando/sdk/schema";
import { Effect, Result, Schema } from "effect";
import { parseConfigPath } from "./write-core.ts";

export type ConfigSchemaName = "GlobalConfig" | "LandofileShape";

const CONFIG_DOCUMENTS = {
  installation: { schema: "GlobalConfig", label: "config.yml", command: "lando config describe" },
  app: { schema: "LandofileShape", label: "Landofile", command: "lando app:config describe" },
  global: { schema: "LandofileShape", label: "Global Landofile", command: "lando global:config describe" },
} as const satisfies Record<string, { schema: ConfigSchemaName; label: string; command: string }>;
export type ConfigDocumentKind = keyof typeof CONFIG_DOCUMENTS;

export const ConfigDescribeResultSchema = Schema.Struct({
  subcommand: Schema.Literal("describe"),
  ...ConfigKeyDescription.fields,
});
export type ConfigDescribeResult = typeof ConfigDescribeResultSchema.Type;
const documents = new Map<ConfigSchemaName, ReturnType<typeof getJsonSchema>>();
const documentFor = (name: ConfigSchemaName) => {
  const cached = documents.get(name);
  if (cached !== undefined) return cached;
  const document = getJsonSchema(name);
  documents.set(name, document);
  return document;
};

const descriptionFor = (name: ConfigSchemaName, path: ValidationIssuePath) =>
  describeJsonSchemaPath(documentFor(name), path);

export const describeConfigKey = Effect.fn("Config.describeKey")(function* (
  kind: ConfigDocumentKind,
  key: string | undefined,
) {
  const document = CONFIG_DOCUMENTS[kind];
  const path =
    key === undefined || key === "" ? [] : yield* Effect.fromResult(parseConfigPath(key, document.label));
  const description = descriptionFor(document.schema, path);
  if (Result.isSuccess(description)) return description.success;
  const { parent, ...failure } = description.failure;
  const parentKey = formatValidationIssuePath(parent);
  return yield* Effect.fail(
    new ConfigKeyNotFoundError({
      message: `Config key \`${key}\` was not found in ${document.label}.`,
      key: key ?? "",
      document: document.label,
      ...failure,
      remediation: `Run \`${document.command}${parentKey === "" ? "" : ` ${parentKey}`}\` to list the valid keys${parentKey === "" ? "" : ` under ${parentKey}`}.`,
    }),
  );
});

export const configKeySummary = (name: ConfigSchemaName, path: ValidationIssuePath): string | undefined => {
  const parsed = descriptionFor(name, path);
  return Result.isSuccess(parsed) ? parsed.success.summary : undefined;
};

export const isAppOnlyConfigKey = (key: string): boolean => {
  const app = descriptionFor("LandofileShape", []);
  const host = descriptionFor("GlobalConfig", []);
  return (
    Result.isSuccess(app) &&
    Result.isSuccess(host) &&
    (app.success.keys ?? []).some((entry) => entry.key === key) &&
    !(host.success.keys ?? []).some((entry) => entry.key === key)
  );
};
