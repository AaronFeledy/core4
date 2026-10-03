import { Effect, Schema, SchemaAST, SchemaParser, SchemaTransformation } from "effect";

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
      toCodecJson: () => new SchemaAST.Link(jsonSchema.check(check).ast, SchemaTransformation.passthrough()),
    },
  );
