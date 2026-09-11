import { describe, expect, test } from "bun:test";
import * as Public from "@lando/sdk/schema";
import { SchemaAST as AST, Either, Option, Schema } from "effect";

// ==== AST derivation contracts
describe("authoring AST derivation", () => {
  test("makes nested properties optional when deriving a fragment", () => {
    // Given
    const ast = Schema.Struct({
      n: Schema.Number,
      s: Schema.String,
      o: Schema.Struct({ b: Schema.Boolean }),
    }).ast;
    const options = { partial: true, slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`) };
    // When
    const derived = Public.deriveAuthoringAst(ast, options);
    // Then
    expect(AST.isUnion(derived)).toBe(true);
    if (!AST.isUnion(derived)) throw new TypeError("Expected union");
    const object = derived.types.find(AST.isTypeLiteral);
    expect(object?.propertySignatures.every((property) => property.isOptional)).toBe(true);
    const number = object?.propertySignatures.find((property) => property.name === "n")?.type;
    if (!number || !AST.isUnion(number)) throw new TypeError("Expected number union");
    expect(number.types.some(AST.isNumberKeyword)).toBe(true);
    expect(number.types.some((member) => AST.isLiteral(member) && member.literal === "<slot:number>")).toBe(
      true,
    );
    expect(number.types.some(AST.isUndefinedKeyword)).toBe(true);
    expect(Public.deriveAuthoringAst(ast, options)).toBe(derived);
    const decode = Schema.decodeUnknownEither(Schema.make(derived));
    expect(decode({ o: {} })._tag).toBe("Right");
  });

  test("preserves object refinements while projecting a transformed input shape", () => {
    // Given
    const schema = Schema.transform(
      Schema.Struct({ value: Schema.Number }).pipe(
        Schema.filter(({ value }) => value > 0 || "Expected a positive value"),
      ),
      Schema.Struct({ value: Schema.Number }),
      { strict: true, decode: (value) => value, encode: (value) => value },
    );
    const derived = Schema.make(
      Public.deriveAuthoringAst(schema.ast, {
        partial: false,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    // When
    const result = Schema.decodeUnknownEither(derived)({ value: -1 });

    // Then
    expect(result._tag).toBe("Left");
  });
});

// ==== Public authoring schema contracts
describe("Landofile authoring schemas", () => {
  const producer = {
    sourceKind: "bundled",
    packageName: "@lando/recipe-demo",
    manifestVersion: "1.0.0",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const authoringDecoders = [
    ["complete shape", Schema.decodeUnknownEither(Public.LandofileAuthoringShape)],
    ["fragment", Schema.decodeUnknownEither(Public.LandofileAuthoringFragment)],
  ] as const;

  test.each(authoringDecoders)(
    "accepts matching unresolved provenance identity in the %s",
    (_name, decode) => {
      // Given
      const expression = "{{ env.RECIPE_ID }}";
      const input = {
        recipe: {
          id: expression,
          version: "1.0.0",
          producer: { ...producer, recipeId: expression },
          options: {},
        },
      };

      // When
      const result = decode(input);

      // Then
      expect(result._tag).toBe("Right");
    },
  );

  test.each(authoringDecoders)(
    "rejects mismatched literal provenance identity in the %s",
    (_name, decode) => {
      // Given
      const input = {
        recipe: {
          id: "demo",
          version: "1.0.0",
          producer: { ...producer, recipeId: "other" },
          options: {},
        },
      };

      // When
      const result = decode(input);

      // Then
      expect(result._tag).toBe("Left");
    },
  );

  test.each(authoringDecoders)(
    "rejects an invalid literal inside unresolved provenance in the %s",
    (_name, decode) => {
      // Given
      const expression = "{{ env.RECIPE_ID }}";
      const input = {
        recipe: {
          id: expression,
          version: "1.0.0",
          producer: { ...producer, recipeId: expression, manifestVersion: "not-semver" },
          options: {},
        },
      };

      // When
      const result = decode(input);

      // Then
      expect(result._tag).toBe("Left");
    },
  );

  test.each(authoringDecoders)(
    "rejects literal provenance mismatch with an unrelated option expression in the %s",
    (_name, decode) => {
      // Given
      const input = {
        recipe: {
          id: "demo",
          version: "1.0.0",
          producer: { ...producer, recipeId: "other" },
          options: { php: "{{ env.PHP_VERSION }}" },
        },
      };

      // When
      const result = decode(input);

      // Then
      expect(result._tag).toBe("Left");
    },
  );

  test("defers complete-object provenance semantics for an incomplete fragment", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringFragment)({
      recipe: { id: "demo" },
    });

    // Then
    expect(result._tag).toBe("Right");
  });

  test("rejects an expression at the complete Landofile root", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringShape)("{{ vars.landofile }}");

    // Then
    expect(result._tag).toBe("Left");
  });

  test("keeps the complete Landofile root object-only without inventing required fields", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringShape)({});

    // Then
    expect(result).toMatchObject({ _tag: "Right", right: {} });
  });

  test("decodes a whole string expression without resolving it", () => {
    // Given
    const input = { name: '{{ env.X | default("a") }}' };
    // When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringShape)(input);
    // Then
    expect(Either.isRight(result)).toBe(true);
    if (Either.isLeft(result)) throw result.left;
    expect(result.right).toMatchObject({
      name: { _tag: "AuthoringExpression", form: "whole", expectedType: "string", scopes: ["env"] },
    });
  });

  test("encodes a decoded authoring value back to its exact source", () => {
    // Given
    const input = { name: '{{ env.X | default("a") }}' };
    const decoded = Schema.decodeUnknownSync(Public.LandofileAuthoringShape)(input);
    // When
    const encoded = Schema.encodeSync(Public.LandofileAuthoringShape)(decoded);
    // Then
    expect(encoded).toEqual(input);
  });

  test("accepts a whole expression at an integer site", () => {
    // Given
    const input = { router: { httpPort: "{{ env.P }}" } };
    // When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringShape)(input);
    // Then
    expect(result).toMatchObject({
      _tag: "Right",
      right: { router: { httpPort: { expectedType: "number" } } },
    });
  });

  test.each([
    { router: { httpPort: "v{{ env.P }}" } },
    { router: { enabled: "{{ length(app.name) }}" } },
    { name: "{{ nope.x }}" },
    { name: "{{ frobnicate(env.X) }}" },
  ])("rejects invalid or incompatible expressions: %j", (input) => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringShape)(input);
    // Then
    expect(result._tag).toBe("Left");
  });

  test("keeps a plain name as a string", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringShape)({ name: "plain" });
    // Then
    expect(result).toMatchObject({ _tag: "Right", right: { name: "plain" } });
  });

  test("accepts a missing nested required field in a fragment", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringFragment)({
      toolingIncludes: { shared: {} },
    });
    // Then
    expect(result._tag).toBe("Right");
  });

  test("requires a nested required field in a complete shape", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringShape)({
      toolingIncludes: { shared: {} },
    });
    // Then
    expect(result._tag).toBe("Left");
  });

  test("accepts a service port expression in a fragment", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringFragment)({
      services: { web: { type: "lando", port: "{{ env.PORT }}" } },
    });
    // Then
    expect(result._tag).toBe("Right");
  });

  test("rejects runtime-only keys under strict excess-property handling", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(Public.LandofileAuthoringFragment)(
      { appId: "x", plan: {} },
      { onExcessProperty: "error" },
    );
    // Then
    expect(result._tag).toBe("Left");
  });

  test("suffixes nested identifiers in a fragment", () => {
    // Given
    const identifiers = new Set<string>();
    const seen = new Set<AST.AST>();
    const visit = (ast: AST.AST): void => {
      if (seen.has(ast)) return;
      seen.add(ast);
      const identifier = AST.getIdentifierAnnotation(ast);
      if (Option.isSome(identifier)) identifiers.add(identifier.value);
      switch (ast._tag) {
        case "TypeLiteral":
          for (const property of ast.propertySignatures) visit(property.type);
          for (const index of ast.indexSignatures) visit(index.type);
          return;
        case "Union":
          ast.types.forEach(visit);
          return;
        case "TupleType":
          for (const element of [...ast.elements, ...ast.rest]) visit(element.type);
          return;
        case "Refinement":
          visit(ast.from);
          return;
        case "Transformation":
          visit(ast.from);
          visit(ast.to);
          return;
        case "Suspend":
          visit(ast.f());
          return;
        default:
          return;
      }
    };
    // When
    visit(Public.LandofileAuthoringFragment.ast);
    // Then
    expect(identifiers.has("ServiceConfigInputAuthoringFragment")).toBe(true);
    expect(identifiers.has("ServiceConfigInput")).toBe(false);
    expect(identifiers.has("Int")).toBe(true);
  });
});
