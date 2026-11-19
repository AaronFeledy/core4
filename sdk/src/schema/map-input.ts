import { Effect, Schema, SchemaAST, SchemaParser, SchemaTransformation } from "effect";

/**
 * The input AST a declaration decodes, published for structural redaction. A
 * custom declaration hides its input shape from `Schema.toEncoded`; redaction
 * can only prove a declared key or a schema-fixed literal by reading that shape.
 */
export const SchemaDeclarationInputAnnotationId = "lando/schema/DeclarationInput" as const;

// Keep the precheck inside the declaration parser so Schema.toEncoded retains it
// and the native record validation. The JSON codec derives the same map contract.
export const mapInputWithPrecheck = <S extends Schema.Top>(
  schema: S,
  check: SchemaAST.Filter<unknown>,
  jsonSchema: Schema.Top = schema,
) =>
  Schema.declareConstructor<S["Type"]>()(
    [schema],
    ([record]) =>
      (input, _ast, options) =>
        SchemaParser.decodeUnknownEffect(Schema.Unknown.check(check))(input, options).pipe(
          Effect.flatMap(() => SchemaParser.decodeUnknownEffect(record)(input, options)),
        ),
    {
      "lando/map-input": true,
      [SchemaDeclarationInputAnnotationId]: schema.ast,
      toCodecJson: () => new SchemaAST.Link(jsonSchema.check(check).ast, SchemaTransformation.passthrough()),
    },
  );
