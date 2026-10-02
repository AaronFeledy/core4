import { SchemaIssue, SchemaTransformation } from "effect";
import { Effect } from "effect";
import { Schema } from "effect";

const RESERVED_KEY_PROPERTY_NAMES = { not: { const: "__proto__" } } as const;

const ComposeScalar = Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null]);
export const ComposeScalarMap = Schema.Record(Schema.String, ComposeScalar);
export type ComposeScalarMap = typeof ComposeScalarMap.Type;
const ExtraHostsRecord = Schema.Record(
  Schema.String,
  Schema.Union([Schema.String, Schema.Array(Schema.String)]),
);

const ReservedComposeScalarMapInput = Schema.Unknown.annotate({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
    },
  },
});

const ReservedExtraHostsMapInput = Schema.Unknown.annotate({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
  },
});

const reservedMapKeyFailure = (input: unknown) =>
  Effect.fail(
    new SchemaIssue.InvalidValue(
      {
        message: 'The key "__proto__" is reserved and cannot be used in a Landofile map; choose another key.',
      },
      input,
    ),
  );

const reservedMapKeyCheck = Schema.makeFilter(
  (input: unknown) => !(typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")),
  {
    message: 'The key "__proto__" is reserved and cannot be used in a Landofile map; choose another key.',
  },
);

const ComposeScalarMapInput = ReservedComposeScalarMapInput.check(reservedMapKeyCheck).pipe(
  Schema.decodeTo(ComposeScalarMap),
);

const ComposeExtraHostsMapInput = ReservedExtraHostsMapInput.check(reservedMapKeyCheck).pipe(
  Schema.decodeTo(ExtraHostsRecord),
);

const splitMappingEntry = (
  entry: string,
  separator: "equals" | "host",
): readonly [string, string] | undefined => {
  const equalsIndex = entry.indexOf("=");
  const index = separator === "host" && equalsIndex < 0 ? entry.indexOf(":") : equalsIndex;
  if (index <= 0 || index === entry.length - 1) return undefined;
  return [entry.slice(0, index), entry.slice(index + 1)];
};

const isStringList = (input: unknown): input is ReadonlyArray<string> =>
  Array.isArray(input) && input.every((entry) => typeof entry === "string");

export const ComposeScalarMapField = Schema.Union([ComposeScalarMapInput, Schema.Array(Schema.String)]).pipe(
  Schema.decodeTo(
    ComposeScalarMap,
    SchemaTransformation.transformEffect({
      decode: (input, _options) => {
        if (!isStringList(input)) return Effect.succeed(input);
        const entries: Array<readonly [string, string]> = [];
        for (const entry of input) {
          const pair = splitMappingEntry(entry, "equals");
          if (pair === undefined) {
            return Effect.fail(
              new SchemaIssue.InvalidValue(
                { message: "Landofile service map entries must use KEY=value." },
                input,
              ),
            );
          }
          entries.push(pair);
        }
        const record = Object.fromEntries(entries);
        if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record);
        return Effect.succeed(record);
      },
      encode: (record) => Effect.succeed(record),
    }),
  ),
);

export const ComposeSysctlsField = ComposeScalarMapField.annotate({
  description: "Kernel parameters as a Compose scalar map or KEY=value list; canonicalized to a scalar map.",
});
export type ComposeSysctls = typeof ComposeSysctlsField.Type;

export const ComposeExtraHostsField = Schema.Union([ComposeExtraHostsMapInput, Schema.Array(Schema.String)])
  .pipe(
    Schema.decodeTo(
      ExtraHostsRecord,
      SchemaTransformation.transformEffect({
        decode: (input, _options) => {
          if (!isStringList(input)) return Effect.succeed(input);
          const entries: Array<readonly [string, string]> = [];
          for (const entry of input) {
            const pair = splitMappingEntry(entry, "host");
            if (pair === undefined) {
              return Effect.fail(
                new SchemaIssue.InvalidValue(
                  { message: "Landofile service extra_hosts entries must use HOST=IP or HOST:IP." },
                  input,
                ),
              );
            }
            entries.push(pair);
          }
          const record = Object.fromEntries(entries);
          if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record);
          return Effect.succeed(record);
        },
        encode: (record) => Effect.succeed(record),
      }),
    ),
  )
  .annotate({
    description:
      "Additional host mappings as a hostname-to-address map or HOST=IP and HOST:IP list; canonicalized to a hostname map.",
  });
export type ComposeExtraHosts = typeof ComposeExtraHostsField.Type;
