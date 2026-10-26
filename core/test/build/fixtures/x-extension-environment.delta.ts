import {
  authoringExpressionSlot,
  deriveAuthoringAst,
  getJsonSchemaWithDeprecations,
} from "@lando/sdk/schema";
import { Schema } from "effect";
import { normalizeJsonSchema } from "../../../../scripts/schema-compatibility/normalize.ts";
import { wireObject } from "../x-extension-wire-proof.ts";

// Reviewed encoded contract from 14b66d1b9, not imported from the live value schemas.
// Only the generic production authoring/JSON projection is shared with the producer.
const reference = Schema.String;
const secret = Schema.Struct({ _tag: Schema.Literal("SecretRef"), reference });
const boundReference = Schema.Struct({
  reference,
  encoding: Schema.Literals(["raw", "uri-component"]),
});
const bound = Schema.Struct({
  _tag: Schema.Literal("BoundText"),
  parts: Schema.Array(Schema.Union([Schema.String, boundReference])).check(Schema.isMaxLength(10_000)),
});
const value = Schema.Union([Schema.String, secret, bound]);
const reservedKey = Schema.makeFilter(
  (input: Record<string, unknown>) => !Object.hasOwn(input, "__proto__"),
  {
    toJsonSchema: () => ({ propertyNames: { not: { const: "__proto__" } } }),
  },
);
const environment = (entry: Schema.Top) =>
  Schema.Union([
    Schema.Record(Schema.String, Schema.Union([entry, Schema.Finite, Schema.Boolean, Schema.Null])).check(
      reservedKey,
    ),
    Schema.Array(Schema.String),
  ]);
const oldEnvironment = environment(Schema.String);
const newEnvironment = environment(value);
const toolingEnvironment = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
);

const fields = (password: Schema.Top, env: Schema.Top, serviceEnvironment: Schema.Top) =>
  [
    Schema.Struct({ password, rootPassword: password, env, environment: serviceEnvironment }),
    Schema.Struct({
      password: Schema.optionalKey(password),
      rootPassword: Schema.optionalKey(password),
      env: Schema.optionalKey(env),
      environment: Schema.optionalKey(serviceEnvironment),
    }),
  ] as const;

const environmentProjection = (schema: Schema.Top, mode: "bare" | "authoring" | "fragment") => {
  const projected =
    mode === "bare"
      ? schema
      : Schema.make<Schema.Codec<unknown>>(
          deriveAuthoringAst(schema.ast, {
            partial: mode === "fragment",
            directives: mode === "fragment",
            // Separate memoization key for each projection, as in the production owners.
            slotFor: (kind) => authoringExpressionSlot(kind).ast,
            rootExpression: false,
          }),
        );
  return normalizeJsonSchema(
    wireObject(getJsonSchemaWithDeprecations(projected, { onExcessProperty: "error" })),
  );
};

const previous = fields(Schema.String, toolingEnvironment, oldEnvironment);
const next = fields(value, newEnvironment, newEnvironment);
export const environmentDeltas = (["bare", "authoring", "fragment"] as const).flatMap((mode) =>
  ([0, 1] as const).map((index) => ({
    mode,
    before: environmentProjection(previous[index], mode),
    after: environmentProjection(next[index], mode),
  })),
);
