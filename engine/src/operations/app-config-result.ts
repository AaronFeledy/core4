import {
  LandofileShape,
  LandofileSourceDocument,
  LandofileSourceProjection,
  LandofileSourceValue,
} from "@lando/sdk/schema";
import { Schema } from "effect";

export const HostEventAppStatus = Schema.Struct({
  event: Schema.String,
  index: Schema.Number.pipe(Schema.check(Schema.isInt()), Schema.check(Schema.isGreaterThanOrEqualTo(0))),
  step: Schema.Unknown,
  status: Schema.Literals(["active", "skipped", "deduped"]),
  reason: Schema.optionalKey(Schema.String),
});
export type HostEventAppStatus = typeof HostEventAppStatus.Type;

const metadata = {
  app: Schema.optionalKey(Schema.String),
  sources: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({
        id: Schema.String,
        sha256: Schema.String.pipe(Schema.check(Schema.isPattern(/^[a-f0-9]{64}$/u))),
      }),
    ),
  ),
  hostEvents: Schema.optionalKey(Schema.Array(HostEventAppStatus)),
};
const selection = { value: Schema.optionalKey(LandofileSourceValue) };
const write = { filePath: Schema.String, dryRun: Schema.optionalKey(Schema.Boolean) };
const fullView = { path: Schema.optionalKey(Schema.Never), subcommand: Schema.optionalKey(Schema.Never) };

export const AppConfigResultSchema = Schema.Union([
  Schema.Struct({
    app: metadata.app,
    source: Schema.Literal("resolved"),
    landofile: LandofileShape,
    sources: metadata.sources,
    hostEvents: metadata.hostEvents,
    ...fullView,
  }),
  Schema.Struct({
    ...metadata,
    ...fullView,
    source: Schema.Literal("merged"),
    landofile: LandofileSourceValue,
  }),
  Schema.Struct({
    ...metadata,
    ...fullView,
    source: Schema.Literal("raw"),
    layers: Schema.Array(LandofileSourceDocument),
  }),
  Schema.Struct({
    ...metadata,
    subcommand: Schema.optionalKey(Schema.Never),
    source: Schema.Literal("raw"),
    path: Schema.String,
    layers: Schema.Array(LandofileSourceProjection),
  }),
  Schema.Struct({
    ...metadata,
    subcommand: Schema.optionalKey(Schema.Never),
    source: Schema.Literals(["merged", "resolved"]),
    path: Schema.String,
    ...selection,
  }),
  Schema.Struct({
    ...metadata,
    source: Schema.Literal("raw"),
    subcommand: Schema.Literal("get"),
    key: Schema.String,
    value: Schema.optionalKey(Schema.Array(LandofileSourceProjection)),
  }),
  Schema.Struct({
    ...metadata,
    source: Schema.Literals(["merged", "resolved"]),
    subcommand: Schema.Literal("get"),
    key: Schema.String,
    ...selection,
  }),
  Schema.Struct({
    ...write,
    subcommand: Schema.Literal("set"),
    key: Schema.String,
    value: LandofileSourceValue,
    changed: Schema.Literal(true),
  }),
  Schema.Struct({
    ...write,
    subcommand: Schema.Literal("unset"),
    key: Schema.String,
    changed: Schema.Boolean,
  }),
  Schema.Struct({
    ...write,
    subcommand: Schema.Literal("edit"),
    changed: Schema.Literal(true),
    valid: Schema.Literal(true),
  }),
  Schema.Struct({
    ...write,
    subcommand: Schema.Literal("validate"),
    valid: Schema.Literal(true),
    issues: Schema.Array(Schema.String),
  }),
]);
const RedactionMetadata = Schema.Struct({ redactionTokens: Schema.optionalKey(Schema.Array(Schema.String)) });
export type AppConfigResult = typeof AppConfigResultSchema.Type & typeof RedactionMetadata.Type;
