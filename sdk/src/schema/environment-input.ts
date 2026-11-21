import { Effect, Schema, SchemaTransformation } from "effect";
import { Environment, EnvironmentValue } from "./environment-value.ts";
import { indexedPropertyNameCheck, propertyNameCheckedRecord } from "./property-name-check.ts";

const DESCRIPTION =
  "Environment variables as a map (KEY: value) or a Compose-style KEY=value list. Names must be nonempty and cannot be __proto__. Bare entries and null values are rejected.";

const emptyName = "Environment names cannot be empty.";
const reservedName =
  'The key "__proto__" is reserved and cannot be used in an environment map. Choose another name.';

export const EnvironmentAssignment = Schema.String.check(
  Schema.makeFilter<string>(
    (entry) => {
      if (entry.includes("=")) return undefined;
      const name = JSON.stringify(entry);
      const explicit = /^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry)
        ? ` To use a host value, write ${entry}: "{{ env.${entry} }}" in the map.`
        : ' To use a host value, use a whole-value expression such as KEY: "{{ env.KEY }}" in the map.';
      return `Lando does not pass host variables through by name (${name}). Use KEY=value or the map form.${explicit}`;
    },
    { toJsonSchema: () => ({ pattern: /=/u.source }) },
  ),
  Schema.isPattern(/^(?!=)/u, { message: emptyName }),
  Schema.isPattern(/^(?!__proto__=)/u, { message: reservedName }),
);

const EnvironmentMapInput = propertyNameCheckedRecord(
  Schema.Record(
    Schema.String,
    Schema.Union([EnvironmentValue, Schema.Finite, Schema.Boolean]).annotate({
      message: "Supply a concrete environment value; host-environment interpolation is unsupported.",
    }),
  ).annotate({ expected: "a map or a list of KEY=VALUE strings" }),
  indexedPropertyNameCheck(/^[\s\S]/u, emptyName),
  indexedPropertyNameCheck(/^(?!__proto__(?![\s\S]))/u, reservedName),
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
  .annotate({ description: DESCRIPTION })
  .pipe(Schema.annotateEncoded({ landoAuthoredInput: "ComposeEnvironmentInput" }));

export const ToolingEnvironment = ComposeEnvironmentInput.annotate({
  description: "Environment variables supplied to a tooling task as scalar values.",
});
export type ToolingEnvironment = typeof ToolingEnvironment.Type;
