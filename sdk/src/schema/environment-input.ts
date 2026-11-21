import { Effect, Schema, SchemaTransformation } from "effect";
import { Environment, EnvironmentValue } from "./environment-value.ts";
import { indexedPropertyNameCheck, propertyNameCheckedRecord } from "./property-name-check.ts";

const DESCRIPTION =
  "Environment variables as a map (KEY: value) or a Compose-style KEY=value list. Names must be nonempty and cannot be __proto__. Bare entries and null values are rejected.";

const nameCheck = indexedPropertyNameCheck(
  /^(?!__proto__(?![\s\S]))[\s\S]/u,
  'The key "__proto__" is reserved and cannot be used in an environment map. Environment names cannot be empty.',
);

export const EnvironmentAssignment = Schema.String.check(
  Schema.isPattern(/^(?!__proto__=)[^=]+=/u, {
    message:
      'Expected KEY=value with a nonempty, nonreserved environment name. The name "__proto__" is reserved.',
  }),
);

const EnvironmentMapInput = propertyNameCheckedRecord(
  Schema.Record(
    Schema.String,
    Schema.Union([EnvironmentValue, Schema.Finite, Schema.Boolean]).annotate({
      message: "Supply a concrete environment value; host-environment interpolation is unsupported.",
    }),
  ).annotate({ expected: "a map or a list of KEY=VALUE strings" }),
  nameCheck,
);

export const ComposeEnvironmentInput = Schema.Union([
  EnvironmentMapInput,
  Schema.Array(EnvironmentAssignment),
])
  .annotate({ description: DESCRIPTION })
  .pipe(
    Schema.decodeTo(
      Environment,
      SchemaTransformation.transformEffect({
        decode: (input) =>
          Effect.succeed(
            Object.fromEntries(
              Array.isArray(input)
                ? input.map((entry) => {
                    const separator = entry.indexOf("=");
                    return [entry.slice(0, separator), entry.slice(separator + 1)] as const;
                  })
                : Object.entries(input).map(
                    ([key, value]) => [key, typeof value === "object" ? value : String(value)] as const,
                  ),
            ),
          ),
        encode: (record) => Effect.succeed(record),
      }),
    ),
  )
  .annotate({ description: DESCRIPTION });
