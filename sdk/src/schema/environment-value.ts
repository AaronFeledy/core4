import { Result, Schema, SchemaTransformation } from "effect";

import { parseSecretReference } from "../secrets/reference.ts";
import { layerMerge } from "./layer-merge.ts";

// =============================================================================
// Persistable environment descriptors. These schemas grant no authoring authority.
// =============================================================================

/**
 * Namespaced annotation marking a schema position that holds no credential
 * bytes: a published reference descriptor, a declared name/path/id, or a
 * Lando-authored diagnostic field. Structural redaction walks an annotated
 * position with the ordinary rules under a secret-named key, so registered
 * values and patterns still mask; any other position masks free text.
 */
export const SchemaNotCredentialAnnotationId = "lando/schema/NotCredential" as const;

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
  [SchemaNotCredentialAnnotationId]: true,
});
export type SecretRef = typeof SecretRef.Type;

export const BoundTextReference = Schema.Struct({
  reference: SecretReference.annotate({ description: "Raw SecretStore reference identifier." }),
  encoding: Schema.Literals(["raw", "uri-component"]).annotate({
    description: "Explicit transformation applied after lookup.",
  }),
}).annotate({
  identifier: "BoundTextReference",
  description: "One deferred reference in flat bound text.",
  [SchemaNotCredentialAnnotationId]: true,
});
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

/** The public route facts a service publishes: its URL, hostname, and origin. */
export const PUBLIC_ROUTE_FACTS = ["url", "hostname", "origin"] as const;
export type PublicRouteFact = (typeof PUBLIC_ROUTE_FACTS)[number];

export const RouteUrlPart = Schema.Struct({
  service: Schema.String.annotate({ description: "Name of the service whose public route is read." }),
  member: Schema.optionalKey(
    Schema.Literals(["hostname", "origin"]).annotate({
      description:
        "Route fact read instead of the URL: the route hostname, or the scheme, hostname, and port origin.",
    }),
  ),
  encoding: Schema.Literals(["raw", "uri-component"]).annotate({
    description: "Encoding applied to the public route fact.",
  }),
}).annotate({
  identifier: "RouteUrlPart",
  description: "One deferred public service route fact; the URL when no member is named.",
  [SchemaNotCredentialAnnotationId]: true,
});
export type RouteUrlPart = typeof RouteUrlPart.Type;

/** The route fact a part reads. */
export const routeUrlPartFact = (part: RouteUrlPart): PublicRouteFact => part.member ?? "url";

export const RouteText = Schema.Struct({
  _tag: Schema.Literal("RouteText").annotate({ description: "Public route text discriminator." }),
  parts: layerMerge(Schema.Array(Schema.Union([Schema.String, RouteUrlPart])), { kind: "replace" })
    .annotate({ description: "Literal and public route fact parts in output order, limited to 10000 parts." })
    .check(Schema.isMaxLength(10_000)),
}).annotate({
  identifier: "RouteText",
  description: "Deferred text containing literal bytes and public service route facts.",
});
export type RouteText = typeof RouteText.Type;

const EnvironmentValueDescriptor = Schema.Union([Schema.String, SecretRef, BoundText, RouteText])
  .check(
    Schema.makeFilter((value) => new TextEncoder().encode(JSON.stringify(value)).length <= 1_048_576, {
      message: "Environment value exceeds the 1048576-byte expression output budget.",
    }),
  )
  .annotate({
    description: "Literal string or deferred environment descriptor, limited to 1048576 encoded UTF-8 bytes.",
  });
type Descriptor = typeof EnvironmentValueDescriptor.Type;

const normalizeParts = <A>(input: readonly (string | A)[]): (string | A)[] => {
  const parts: (string | A)[] = [];
  for (const part of input) {
    if (part === "") continue;
    const previous = parts.at(-1);
    if (typeof previous === "string" && typeof part === "string") parts[parts.length - 1] = previous + part;
    else parts.push(part);
  }
  return parts;
};

/** Trusted projection only: flatten parts, merge literals, and collapse trivial bindings. */
const normalizeDescriptor = (value: Descriptor): Descriptor => {
  if (typeof value === "string") return value;
  switch (value._tag) {
    case "SecretRef":
      return value;
    case "BoundText": {
      const parts = normalizeParts(value.parts);
      if (parts.length === 0) return "";
      const only = parts[0];
      if (parts.length === 1 && typeof only === "string") return only;
      if (parts.length === 1 && only !== undefined && typeof only !== "string" && only.encoding === "raw")
        return { _tag: "SecretRef", reference: only.reference };
      return { _tag: "BoundText", parts };
    }
    case "RouteText": {
      const parts = normalizeParts(value.parts);
      const first = parts[0];
      if (first === undefined) return "";
      if (parts.length === 1 && typeof first === "string") return first;
      return { _tag: "RouteText", parts };
    }
    default:
      return assertNever(value);
  }
};
const assertNever = (value: never): never => value;

export const normalizeEnvironmentValue = (value: EnvironmentValue): EnvironmentValue =>
  normalizeDescriptor(Schema.decodeUnknownSync(EnvironmentValueDescriptor)(value));

export type EnvironmentValueSchema = Schema.decodeTo<
  typeof EnvironmentValueDescriptor,
  typeof EnvironmentValueDescriptor
>;

export const EnvironmentValue: EnvironmentValueSchema = EnvironmentValueDescriptor.pipe(
  Schema.decodeTo(
    EnvironmentValueDescriptor,
    SchemaTransformation.transform({ decode: normalizeDescriptor, encode: normalizeDescriptor }),
  ),
).annotate({
  identifier: "EnvironmentValue",
  description:
    "Literal string or normalized deferred secret or public route text. Literal strings are never rescanned.",
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

export { encodeUriComponent } from "../secrets/uri-component.ts";
