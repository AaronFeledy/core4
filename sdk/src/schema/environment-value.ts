import { Result, Schema, SchemaTransformation } from "effect";

import { parseSecretReference } from "../secrets/reference.ts";
import { layerMerge } from "./layer-merge.ts";

// =============================================================================
// Persistable environment descriptors. These schemas grant no authoring authority.
// =============================================================================
export const SecretReference = Schema.String.check(
  Schema.makeFilter((value) => Result.isSuccess(parseSecretReference(value)), {
    message: "Expected a valid bare secret id or store URI.",
  }),
).annotate({
  identifier: "SecretReference",
  description: "Validated raw SecretStore reference, never secret bytes.",
});
export type SecretReference = typeof SecretReference.Type;

export const SecretRef = Schema.Struct({
  _tag: Schema.Literal("SecretRef").annotate({
    description: "Secret reference discriminator.",
    expected: "a secret-reference discriminator",
  }),
  reference: SecretReference.annotate({ description: "Raw SecretStore reference identifier." }),
}).annotate({
  identifier: "SecretRef",
  description: "Deferred secret lookup descriptor; contains no decrypted value.",
});
export type SecretRef = typeof SecretRef.Type;

export const BoundTextReference = Schema.Struct({
  reference: SecretReference.annotate({ description: "Raw SecretStore reference identifier." }),
  encoding: Schema.Literals(["raw", "uri-component"]).annotate({
    description: "Explicit transformation applied after lookup.",
  }),
}).annotate({ identifier: "BoundTextReference", description: "One deferred reference in flat bound text." });
export type BoundTextReference = typeof BoundTextReference.Type;

export const BoundText = Schema.Struct({
  _tag: Schema.Literal("BoundText").annotate({
    description: "Bound text discriminator.",
    expected: "a bound-text discriminator",
  }),
  parts: layerMerge(Schema.Array(Schema.Union([Schema.String, BoundTextReference])), { kind: "replace" })
    .annotate({ description: "Flat literal and reference parts in output order, limited to 10000 parts." })
    .check(Schema.isMaxLength(10_000)),
}).annotate({
  identifier: "BoundText",
  description: "Deferred text containing literal bytes and explicit secret references.",
});
export type BoundText = typeof BoundText.Type;

const EnvironmentValueDescriptor = Schema.Union([Schema.String, SecretRef, BoundText])
  .check(
    Schema.makeFilter((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 1_048_576, {
      message: "Environment value exceeds the 1048576-byte expression output budget.",
    }),
  )
  .annotate({
    description: "Literal string or deferred secret descriptor, limited to 1048576 encoded UTF-8 bytes.",
  });
type Descriptor = typeof EnvironmentValueDescriptor.Type;

/** Trusted projection only: flatten parts, merge literals, and collapse trivial bindings. */
const normalizeDescriptor = (value: Descriptor): Descriptor => {
  if (typeof value === "string") return value;
  switch (value._tag) {
    case "SecretRef":
      return value;
    case "BoundText": {
      const parts: Array<string | BoundTextReference> = [];
      for (const part of value.parts) {
        if (typeof part !== "string") {
          parts.push(part);
          continue;
        }
        if (part === "") continue;
        const previous = parts[parts.length - 1];
        if (typeof previous === "string") parts[parts.length - 1] = previous + part;
        else parts.push(part);
      }
      if (parts.length === 0) return "";
      const only = parts[0];
      if (parts.length === 1 && typeof only === "string") return only;
      if (parts.length === 1 && only !== undefined && typeof only !== "string" && only.encoding === "raw")
        return { _tag: "SecretRef", reference: only.reference };
      return { _tag: "BoundText", parts };
    }
    default:
      return assertNever(value);
  }
};
const assertNever = (value: never): never => value;

export const normalizeEnvironmentValue = (value: EnvironmentValue): EnvironmentValue =>
  normalizeDescriptor(Schema.decodeUnknownSync(EnvironmentValueDescriptor)(value));

export const EnvironmentValue = EnvironmentValueDescriptor.pipe(
  Schema.decodeTo(
    EnvironmentValueDescriptor,
    SchemaTransformation.transform({ decode: normalizeDescriptor, encode: normalizeDescriptor }),
  ),
).annotate({
  identifier: "EnvironmentValue",
  description:
    "Literal string or normalized deferred secret-bearing text. Literal strings are never rescanned.",
});
export type EnvironmentValue = typeof EnvironmentValue.Type;

export const Environment = Schema.Record(Schema.String, EnvironmentValue)
  .check(
    Schema.makeFilter((value) => !Object.hasOwn(value, "__proto__"), {
      message: "The environment key __proto__ is reserved.",
      toJsonSchema: () => ({ propertyNames: { not: { const: "__proto__" } } }),
    }),
  )
  .annotate({
    identifier: "Environment",
    description: "Single environment map; an override replaces an entire value regardless of variant.",
  });
export type Environment = typeof Environment.Type;

/** RFC 3986 component encoding of UTF-8 bytes, shared by planning and runtime resolution. */
export const encodeUriComponent = (value: string): string =>
  Array.from(new TextEncoder().encode(value), (byte) =>
    (byte >= 65 && byte <= 90) ||
    (byte >= 97 && byte <= 122) ||
    (byte >= 48 && byte <= 57) ||
    [45, 46, 95, 126].includes(byte)
      ? String.fromCharCode(byte)
      : `%${byte.toString(16).toUpperCase().padStart(2, "0")}`,
  ).join("");
