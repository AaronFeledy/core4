import { Predicate, SchemaAST } from "effect";

// A `x-${string}` index signature is the schema's slot for inert Compose extension metadata.
// Free-form option maps use a String index signature, so their `x-` keys stay runtime input.
const isInertExtensionSlot = (signature: SchemaAST.IndexSignature): boolean => {
  const { parameter } = signature;
  if (!SchemaAST.isTemplateLiteral(parameter)) return false;
  const [head] = parameter.parts;
  return head !== undefined && SchemaAST.isLiteral(head) && head.literal === "x-";
};

// The union member describing a decoded value: the first object node for a record, array node for a list.
const memberFor = (ast: SchemaAST.AST, value: unknown): SchemaAST.AST | undefined => {
  switch (ast._tag) {
    case "Suspend":
      return memberFor(ast.thunk(), value);
    case "Union":
      for (const member of ast.types) {
        const match = memberFor(member, value);
        if (match !== undefined) return match;
      }
      return undefined;
    case "Arrays":
      return Array.isArray(value) ? ast : undefined;
    case "Objects":
      return Predicate.isObject(value) && !Array.isArray(value) ? ast : undefined;
    default:
      return undefined;
  }
};

const objectIdentity = (ast: SchemaAST.Objects, value: Readonly<Record<string, unknown>>) =>
  Object.fromEntries(
    Object.entries(value).flatMap(([key, field]) => {
      const property = ast.propertySignatures.find((signature) => signature.name === key);
      if (property !== undefined) return [[key, withoutInertExtensions(property.type, field)]];
      const slots = ast.indexSignatures.filter((signature) =>
        SchemaAST.isTemplateLiteral(signature.parameter) ? key.startsWith("x-") : true,
      );
      const runtime = slots.find((signature) => !isInertExtensionSlot(signature));
      if (runtime !== undefined) return [[key, withoutInertExtensions(runtime.type, field)]];
      return slots.length > 0 ? [] : [[key, field]];
    }),
  );

/**
 * Canonical knob identity: the decoded value with every schema-declared inert
 * `x-*` extension field removed, so annotating a knob never recreates a container.
 */
export const withoutInertExtensions = (ast: SchemaAST.AST, value: unknown): unknown => {
  const member = memberFor(ast, value);
  if (member === undefined) return value;
  if (SchemaAST.isArrays(member) && Array.isArray(value))
    return value.map((item, index) => {
      const itemAst = member.elements[index] ?? member.rest[0];
      return itemAst === undefined ? item : withoutInertExtensions(itemAst, item);
    });
  if (SchemaAST.isObjects(member) && Predicate.isObject(value) && !Array.isArray(value))
    return objectIdentity(member, value);
  return value;
};
