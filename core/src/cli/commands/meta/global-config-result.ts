import { ConfigDescribeResultSchema } from "@lando/engine/config-write/key-schema";
import { AbsolutePath, LandofileShape } from "@lando/sdk/schema";
import { Schema } from "effect";

export const GlobalAppPathsSchema = Schema.Struct({
  root: AbsolutePath,
  distLandofile: AbsolutePath,
  userLandofile: AbsolutePath,
});

export const GlobalConfigViewResultSchema = Schema.Struct({
  subcommand: Schema.optionalKey(Schema.Never),
  app: Schema.String,
  source: Schema.Literal("global"),
  materialized: Schema.Boolean,
  distLandofile: Schema.String,
  userLandofile: Schema.String,
  paths: GlobalAppPathsSchema,
  landofile: LandofileShape,
});

const GlobalConfigProjectionResultSchema = Schema.Struct({
  subcommand: Schema.optionalKey(Schema.Never),
  source: Schema.Literal("global"),
  path: Schema.String,
  value: Schema.optionalKey(Schema.Unknown),
});

const GlobalConfigGetResultSchema = Schema.Struct({
  subcommand: Schema.Literal("get"),
  key: Schema.String,
  value: Schema.optionalKey(Schema.Unknown),
  changed: Schema.optionalKey(Schema.Never),
  dryRun: Schema.optionalKey(Schema.Never),
  filePath: Schema.optionalKey(Schema.Never),
  valid: Schema.optionalKey(Schema.Never),
  issues: Schema.optionalKey(Schema.Never),
});

const writeReceipt = { changed: Schema.Boolean, dryRun: Schema.Boolean, filePath: Schema.String };

export const GlobalConfigWriteResultSchema = Schema.Union([
  Schema.Struct({
    subcommand: Schema.Literal("set"),
    key: Schema.String,
    value: Schema.Unknown,
    ...writeReceipt,
  }),
  Schema.Struct({
    subcommand: Schema.Literal("unset"),
    key: Schema.String,
    value: Schema.optionalKey(Schema.Never),
    ...writeReceipt,
  }),
  Schema.Struct({
    subcommand: Schema.Literal("edit"),
    key: Schema.optionalKey(Schema.Never),
    value: Schema.optionalKey(Schema.Never),
    valid: Schema.Literal(true),
    ...writeReceipt,
  }),
  Schema.Struct({
    subcommand: Schema.Literal("validate"),
    valid: Schema.Literal(true),
    issues: Schema.Array(Schema.String),
    filePath: Schema.String,
  }),
]);

export const GlobalConfigResultSchema = Schema.Union([
  GlobalConfigViewResultSchema,
  GlobalConfigProjectionResultSchema,
  GlobalConfigGetResultSchema,
  GlobalConfigWriteResultSchema,
  ConfigDescribeResultSchema,
]);
export type GlobalConfigResult = typeof GlobalConfigResultSchema.Type;
