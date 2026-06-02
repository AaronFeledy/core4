import { Schema } from "effect";

const UnknownRecord = Schema.Record({ key: Schema.String, value: Schema.Unknown });
const StringRecord = Schema.Record({ key: Schema.String, value: Schema.String });

export interface ExpressionContext {
  readonly host?: Readonly<Record<string, unknown>> | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly paths?: Readonly<Record<string, unknown>> | undefined;
  readonly app?: Readonly<Record<string, unknown>> | undefined;
  readonly global?: Readonly<Record<string, unknown>> | undefined;
  readonly vars?: Readonly<Record<string, unknown>> | undefined;
  readonly service?: Readonly<Record<string, unknown>> | undefined;
  readonly services?: Readonly<Record<string, unknown>> | undefined;
  readonly plugin?: Readonly<Record<string, unknown>> | undefined;
  readonly info?: Readonly<Record<string, unknown>> | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly globalServices?: Readonly<Record<string, unknown>> | undefined;
}

export const ExpressionContext: Schema.Schema<ExpressionContext> = Schema.Struct({
  host: Schema.optional(UnknownRecord),
  env: Schema.optional(StringRecord),
  paths: Schema.optional(UnknownRecord),
  app: Schema.optional(UnknownRecord),
  global: Schema.optional(UnknownRecord),
  vars: Schema.optional(UnknownRecord),
  service: Schema.optional(UnknownRecord),
  services: Schema.optional(UnknownRecord),
  plugin: Schema.optional(UnknownRecord),
  info: Schema.optional(UnknownRecord),
  secrets: Schema.optional(StringRecord),
  globalServices: Schema.optional(UnknownRecord),
});
