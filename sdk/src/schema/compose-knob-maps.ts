import { ParseResult, Schema } from "effect";
import type * as AST from "effect/SchemaAST";

const RESERVED_KEY_PROPERTY_NAMES = { not: { const: "__proto__" } } as const;

const ComposeScalar = Schema.Union(Schema.String, Schema.Number, Schema.Boolean, Schema.Null);
export const ComposeScalarMap = Schema.Record({ key: Schema.String, value: ComposeScalar });
export type ComposeScalarMap = typeof ComposeScalarMap.Type;
const ExtraHostsRecord = Schema.Record({
  key: Schema.String,
  value: Schema.Union(Schema.String, Schema.Array(Schema.String)),
});

const ReservedComposeScalarMapInput = Schema.Unknown.annotations({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }, { type: "null" }],
    },
  },
});

const ReservedExtraHostsMapInput = Schema.Unknown.annotations({
  jsonSchema: {
    type: "object",
    propertyNames: RESERVED_KEY_PROPERTY_NAMES,
    additionalProperties: {
      anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
    },
  },
});

const reservedMapKeyFailure = (input: unknown, ast: AST.Transformation) =>
  ParseResult.fail(
    new ParseResult.Type(
      ast,
      input,
      'The key "__proto__" is reserved and cannot be used in a Landofile map; choose another key.',
    ),
  );

const decodeReservedKeyMap = (input: unknown, ast: AST.Transformation) =>
  typeof input === "object" && input !== null && Object.hasOwn(input, "__proto__")
    ? reservedMapKeyFailure(input, ast)
    : ParseResult.succeed(input);

const ComposeScalarMapInput = Schema.transformOrFail(ReservedComposeScalarMapInput, ComposeScalarMap, {
  strict: false,
  decode: (input, _options, ast) => decodeReservedKeyMap(input, ast),
  encode: (record) => ParseResult.succeed(record),
});

const ComposeExtraHostsMapInput = Schema.transformOrFail(ReservedExtraHostsMapInput, ExtraHostsRecord, {
  strict: false,
  decode: (input, _options, ast) => decodeReservedKeyMap(input, ast),
  encode: (record) => ParseResult.succeed(record),
});

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

export const ComposeScalarMapField = Schema.transformOrFail(
  Schema.Union(ComposeScalarMapInput, Schema.Array(Schema.String)),
  ComposeScalarMap,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (!isStringList(input)) return ParseResult.succeed(input);
      const entries: Array<readonly [string, string]> = [];
      for (const entry of input) {
        const pair = splitMappingEntry(entry, "equals");
        if (pair === undefined) {
          return ParseResult.fail(
            new ParseResult.Type(ast, input, "Landofile service map entries must use KEY=value."),
          );
        }
        entries.push(pair);
      }
      const record = Object.fromEntries(entries);
      if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record, ast);
      return ParseResult.succeed(record);
    },
    encode: (record) => ParseResult.succeed(record),
  },
);

export const ComposeSysctlsField = ComposeScalarMapField.annotations({
  description: "Kernel parameters as a Compose scalar map or KEY=value list; canonicalized to a scalar map.",
});
export type ComposeSysctls = typeof ComposeSysctlsField.Type;

export const ComposeExtraHostsField = Schema.transformOrFail(
  Schema.Union(ComposeExtraHostsMapInput, Schema.Array(Schema.String)),
  ExtraHostsRecord,
  {
    strict: true,
    decode: (input, _options, ast) => {
      if (!isStringList(input)) return ParseResult.succeed(input);
      const entries: Array<readonly [string, string]> = [];
      for (const entry of input) {
        const pair = splitMappingEntry(entry, "host");
        if (pair === undefined) {
          return ParseResult.fail(
            new ParseResult.Type(
              ast,
              input,
              "Landofile service extra_hosts entries must use HOST=IP or HOST:IP.",
            ),
          );
        }
        entries.push(pair);
      }
      const record = Object.fromEntries(entries);
      if (Object.hasOwn(record, "__proto__")) return reservedMapKeyFailure(record, ast);
      return ParseResult.succeed(record);
    },
    encode: (record) => ParseResult.succeed(record),
  },
).annotations({
  description:
    "Additional host mappings as a hostname-to-address map or HOST=IP and HOST:IP list; canonicalized to a hostname map.",
});
export type ComposeExtraHosts = typeof ComposeExtraHostsField.Type;
