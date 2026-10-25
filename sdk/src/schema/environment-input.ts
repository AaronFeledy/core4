import { Effect, Schema, SchemaIssue, SchemaTransformation } from "effect";

import { Environment, EnvironmentValue } from "./environment-value.ts";
import { mapInputWithPrecheck } from "./map-input.ts";

// =============================================================================
// Shared service, tooling and event environment input normalization.
// =============================================================================
const DESCRIPTION =
  "Environment variables as a map (KEY: value) or a Compose-style KEY=value list. Bare entries and null values are rejected; host environment interpolation is unsupported.";

const reservedKeyCheck = Schema.makeFilter(
  (input: unknown) => !(typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")),
  {
    message: 'The key "__proto__" is reserved and cannot be used in an environment map.',
    toJsonSchema: () => ({ propertyNames: { not: { const: "__proto__" } } }),
  },
);

const EnvironmentMapInput = mapInputWithPrecheck(
  Schema.Record(
    Schema.String,
    Schema.Union([EnvironmentValue, Schema.Finite, Schema.Boolean, Schema.Null]),
  ).annotate({ expected: "a map or a list of KEY=VALUE strings" }),
  reservedKeyCheck,
);

export const ComposeEnvironmentInput = Schema.Union([EnvironmentMapInput, Schema.Array(Schema.String)])
  .annotate({ description: DESCRIPTION })
  .pipe(
    Schema.decodeTo(
      Environment,
      SchemaTransformation.transformEffect({
        decode: (input) => {
          if (!Array.isArray(input)) {
            const entries = Object.entries(input);
            const unresolved = entries.find(([, value]) => value === null);
            if (unresolved !== undefined) {
              return Effect.fail(
                new SchemaIssue.InvalidValue(
                  {
                    message: `Landofile service environment entry "${unresolved[0]}" has no value; host-environment interpolation is unsupported in Landofiles — provide a concrete value.`,
                  },
                  input,
                ),
              );
            }
            return Effect.succeed(
              Object.fromEntries(
                entries.map(([key, value]) => [
                  key,
                  typeof value === "object" && value !== null ? value : String(value),
                ]),
              ),
            );
          }
          const entries: Array<readonly [string, string]> = [];
          for (const entry of input) {
            const separator = entry.indexOf("=");
            if (separator < 0) {
              return Effect.fail(
                new SchemaIssue.InvalidValue(
                  {
                    message: `Landofile service environment entry "${entry}" must be KEY=value; host-environment interpolation is unsupported in Landofiles — use the map form (environment: { KEY: value }).`,
                  },
                  input,
                ),
              );
            }
            entries.push([entry.slice(0, separator), entry.slice(separator + 1)]);
          }
          const record = Object.fromEntries(entries);
          if (Object.hasOwn(record, "__proto__")) {
            return Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: 'The key "__proto__" is reserved and cannot be used in an environment map.' },
                input,
              ),
            );
          }
          return Effect.succeed(record);
        },
        encode: (record) => Effect.succeed(record),
      }),
    ),
  )
  .annotate({ description: DESCRIPTION });
