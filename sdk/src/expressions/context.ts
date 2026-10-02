import { Schema } from "effect";

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown);
const StringRecord = Schema.Record(Schema.String, Schema.String);

export interface ExpressionContext {
  readonly host?: Readonly<Record<string, unknown>> | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly paths?: Readonly<Record<string, unknown>> | undefined;
  readonly app?: Readonly<Record<string, unknown>> | undefined;
  readonly proxy?: Readonly<Record<string, unknown>> | undefined;
  readonly global?: Readonly<Record<string, unknown>> | undefined;
  readonly vars?: Readonly<Record<string, unknown>> | undefined;
  /** Already-resolved recipe option values supplied by the caller; performs no lookup and runs no recipe code. */
  readonly options?: Readonly<Record<string, unknown>> | undefined;
  /** Recipe option values read from a Landofile's own `recipe.options`; performs no lookup and runs no recipe code. */
  readonly recipe?: Readonly<Record<string, unknown>> | undefined;
  readonly service?: Readonly<Record<string, unknown>> | undefined;
  readonly services?: Readonly<Record<string, unknown>> | undefined;
  readonly plugin?: Readonly<Record<string, unknown>> | undefined;
  readonly info?: Readonly<Record<string, unknown>> | undefined;
  readonly secrets?: Readonly<Record<string, string>> | undefined;
  readonly globalServices?: Readonly<Record<string, unknown>> | undefined;
  readonly event?: Readonly<Record<string, unknown>> | undefined;
  readonly item?: unknown;
  readonly key?: string | number | undefined;
}

export const ExpressionContext: Schema.Codec<ExpressionContext> = Schema.Struct({
  host: Schema.optionalKey(UnknownRecord),
  env: Schema.optionalKey(StringRecord),
  paths: Schema.optionalKey(UnknownRecord),
  app: Schema.optionalKey(UnknownRecord),
  proxy: Schema.optionalKey(UnknownRecord),
  global: Schema.optionalKey(UnknownRecord),
  vars: Schema.optionalKey(UnknownRecord),
  options: Schema.optionalKey(
    UnknownRecord.annotate({
      description:
        "Already-resolved recipe option values supplied by the caller; performs no lookup and runs no recipe code.",
    }),
  ),
  recipe: Schema.optionalKey(
    UnknownRecord.annotate({
      description:
        "Recipe option values read from a Landofile's own recipe.options; performs no lookup and runs no recipe code.",
    }),
  ),
  service: Schema.optionalKey(UnknownRecord),
  services: Schema.optionalKey(UnknownRecord),
  plugin: Schema.optionalKey(UnknownRecord),
  info: Schema.optionalKey(UnknownRecord),
  secrets: Schema.optionalKey(StringRecord),
  globalServices: Schema.optionalKey(UnknownRecord),
  event: Schema.optionalKey(UnknownRecord),
  item: Schema.optionalKey(Schema.Unknown),
  key: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number])),
});
