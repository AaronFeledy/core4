import { describe, expect, test } from "bun:test";
import { override, reset } from "@lando/sdk/landofile";
import { getJsonSchema } from "@lando/sdk/schema";
import * as Public from "@lando/sdk/schema";
import { SchemaAST as AST, Effect, Result, Schema, SchemaTransformation } from "effect";

// ==== AST derivation contracts
describe("authoring AST derivation", () => {
  const expressionSlot = (kind: string) =>
    Schema.Struct({
      _tag: Schema.Literal("AuthoringExpression"),
      source: Schema.String,
      expectedType: Schema.Literal(kind),
    }).ast;

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
    const object = derived.types.find(AST.isObjects);
    expect(object?.propertySignatures.every((property) => AST.isOptional(property.type))).toBe(true);
    const number = object?.propertySignatures.find((property) => property.name === "n")?.type;
    if (!number || !AST.isUnion(number)) throw new TypeError("Expected number union");
    expect(number.types.some(AST.isNumber)).toBe(true);
    expect(number.types.some((member) => AST.isLiteral(member) && member.literal === "<slot:number>")).toBe(
      true,
    );
    expect(AST.isOptional(number)).toBe(true);
    expect(number.types.some(AST.isUndefined)).toBe(false);
    expect(Public.deriveAuthoringAst(ast, options)).toBe(derived);
    const decode = Schema.decodeUnknownResult(Schema.make<Schema.Codec<unknown>>(derived));
    expect(decode({ o: {} })._tag).toBe("Success");
  });

  test("preserves object refinements while projecting a transformed input shape", () => {
    // Given
    const schema = Schema.Struct({ value: Schema.Number })
      .check(Schema.makeFilter(({ value }) => value > 0 || "Expected a positive value"))
      .pipe(
        Schema.decodeTo(
          Schema.Struct({ value: Schema.Number }),
          SchemaTransformation.transform({ decode: (value) => value, encode: (value) => value }),
        ),
      );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(schema.ast, {
        partial: false,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    // When
    const result = Schema.decodeUnknownResult(derived)({ value: -1 });

    // Then
    expect(result._tag).toBe("Failure");
  });

  test("preserves nested input refinements through a decodeTo boundary", () => {
    const input = Schema.Struct({
      children: Schema.Array(
        Schema.Struct({
          name: Schema.String.check(Schema.isMinLength(2)),
        }),
      ),
    });
    const schema = input.pipe(
      Schema.decodeTo(
        Schema.Struct({ children: Schema.Array(Schema.Struct({ name: Schema.String })) }),
        SchemaTransformation.transform({ decode: (value) => value, encode: (value) => value }),
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(schema.ast, {
        partial: false,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    expect(Schema.decodeUnknownResult(derived)({ children: [{ name: "x" }] })._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(derived)({ children: [{ name: "xy" }] })._tag).toBe("Success");
  });

  test("checks nested defaults through chained decodeTo boundaries", () => {
    const child = Schema.Struct({
      label: Schema.String.pipe(Schema.withDecodingDefaultKey(Effect.succeed("bad"))),
    }).check(Schema.makeFilter(({ label }) => label.toUpperCase() === "GOOD" || "Expected GOOD"));
    const first = Schema.Union([Schema.Struct({ child }), Schema.Literal(false)]).pipe(
      Schema.decodeTo(
        Schema.Union([
          Schema.Struct({ child: Schema.Struct({ label: Schema.String }) }),
          Schema.Literal(false),
        ]),
        SchemaTransformation.transform({ decode: (value) => value, encode: (value) => value }),
      ),
    );
    const source = first.pipe(
      Schema.decodeTo(
        Schema.toType(first),
        SchemaTransformation.transform({ decode: (value) => value, encode: (value) => value }),
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: false,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    expect(Schema.decodeUnknownResult(source)({ child: {} })._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(derived)({ child: {} })._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(derived)({ child: { label: "good" } })._tag).toBe("Success");
  });

  test("keeps a canonical JSON reference for a checked child under decodeTo", () => {
    const source = Schema.Struct({ notice: Public.DeprecationNotice }).pipe(
      Schema.decodeTo(
        Schema.Struct({ notice: Schema.toType(Public.DeprecationNotice) }),
        SchemaTransformation.transform({ decode: (value) => value, encode: (value) => value }),
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: false,
        rootExpression: false,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );
    const document = Schema.toJsonSchemaDocument(derived);

    expect(document.schema).toHaveProperty(
      ["properties", "notice", "anyOf", 0, "$ref"],
      "#/$defs/DeprecationNotice",
    );
    expect(document.definitions).toHaveProperty(["DeprecationNotice", "required"], ["since", "note"]);
    expect(document.definitions).toHaveProperty(["DeprecationNotice", "properties", "severity"]);
    expect(Schema.decodeUnknownResult(derived)({ notice: { since: "4.0.0", note: "Old" } })._tag).toBe(
      "Failure",
    );
  });

  test("defers a checked parent when a nested fragment is incomplete", () => {
    const child = Schema.Struct({
      enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
      required: Schema.String,
    });
    const source = Schema.Struct({ child }).check(Schema.makeFilter(() => true));
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: true,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    expect(Schema.decodeUnknownResult(derived)({ child: {} })._tag).toBe("Success");
  });

  test("defers a checked parent for a viable incomplete union branch", () => {
    const child = Schema.Union([
      Schema.Struct({ tag: Schema.String, n: Schema.Number }),
      Schema.Struct({ tag: Schema.Number }),
    ]);
    const source = Schema.Struct({
      enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(true))),
      child,
    }).check(Schema.makeFilter(() => true));
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: true,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    expect(
      Schema.decodeUnknownResult(derived)(
        { child: { tag: "a" } },
        { onExcessProperty: "error", errors: "all" },
      )._tag,
    ).toBe("Success");
  });

  test("checks an array after defaulting its elements", () => {
    const element = Schema.Struct({
      enabled: Schema.Boolean.pipe(Schema.withDecodingDefaultKey(Effect.succeed(false))),
    });
    const source = Schema.Array(element).check(
      Schema.makeFilter((items) => items.every((item) => item.enabled) || "Expected enabled items"),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: false,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    expect(Schema.decodeUnknownResult(source)([{}])._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(derived)([{}])._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(derived)([{ enabled: true }])._tag).toBe("Success");
  });

  test("checks normalized transformed children while keeping shorthand input", () => {
    const source = Schema.Struct({
      mount: Public.AppMountInput,
      probe: Public.HealthcheckInput,
    }).check(
      Schema.makeFilter(({ mount, probe }) =>
        mount !== false &&
        mount.target.toUpperCase() === "/SITE" &&
        probe !== false &&
        probe.command?.toString().toUpperCase() === "PING"
          ? undefined
          : "Expected /site and ping",
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: false,
        slotFor: (kind: string) => new AST.Literal(`<slot:${kind}>`),
      }),
    );

    expect(Schema.decodeUnknownResult(derived)({ mount: "/site", probe: "ping" })._tag).toBe("Success");
    expect(Schema.decodeUnknownResult(derived)({ mount: "/bad", probe: "ping" })._tag).toBe("Failure");
    expect(Schema.decodeUnknownResult(derived)({ mount: "/site", probe: "bad" })._tag).toBe("Failure");
  });

  test("keeps a literal cross-field error when another field has an expression", () => {
    const source = Schema.Struct({ a: Schema.Number, b: Schema.Number, n: Schema.Number }).check(
      Schema.makeFilter(({ a, b }) =>
        a < b ? undefined : { path: ["b"], issue: "Expected b greater than a" },
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, { partial: false, slotFor: expressionSlot }),
    );
    const expression = { _tag: "AuthoringExpression", source: "{{ env.N }}", expectedType: "number" };

    expect(Schema.decodeUnknownResult(derived)({ a: 2, b: 1, n: expression })._tag).toBe("Failure");
  });

  test("defers a transformed-child check when its field is a whole expression", () => {
    const source = Schema.Struct({ mount: Public.AppMountInput }).check(
      Schema.makeFilter(({ mount }) =>
        mount !== false && mount.target.startsWith("/")
          ? undefined
          : { path: ["mount", "target"], issue: "Expected an absolute mount" },
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: true,
        rootExpression: false,
        slotFor: expressionSlot,
        directives: true,
        nativeDirectives: true,
      }),
    );
    const expression = { _tag: "AuthoringExpression", source: "{{ env.MOUNT }}", expectedType: "object" };

    expect(Schema.decodeUnknownResult(derived)({ mount: expression })._tag).toBe("Success");
    expect(Schema.decodeUnknownResult(derived)({ mount: override(expression) })._tag).toBe("Success");
  });

  test("defers a Type-only check when an unrelated expression prevents normalization", () => {
    const source = Schema.Struct({ mount: Public.AppMountInput, n: Schema.Number }).check(
      Schema.makeFilter(({ mount }) =>
        mount !== false && mount.target === "/site"
          ? undefined
          : { path: ["mount", "target"], issue: "Expected /site" },
      ),
    );
    const derived = Schema.make<Schema.Codec<unknown>>(
      Public.deriveAuthoringAst(source.ast, {
        partial: false,
        slotFor: expressionSlot,
      }),
    );
    const expression = { _tag: "AuthoringExpression", source: "{{ env.N }}", expectedType: "number" };

    expect(Schema.decodeUnknownResult(derived)({ mount: "/wrong", n: 1 })._tag).toBe("Failure");
    // The sibling mount check needs a fully normalized parent; n resolves later.
    expect(Schema.decodeUnknownResult(derived)({ mount: "/wrong", n: expression })._tag).toBe("Success");
  });
});

// ==== Public authoring schema contracts
describe("Landofile authoring schemas", () => {
  test("programmatic authoring and translator fragments accept shorthand inputs", () => {
    const input = Public.defineLandofile({
      name: "shorthand",
      services: {
        db: { healthcheck: false },
        web: { healthcheck: "pg_isready", appMount: "/site" },
      },
    }) satisfies typeof Public.LandofileAuthoringShape.Encoded;
    const fragment = {
      services: input.services,
    } satisfies typeof Public.LandofileAuthoringFragment.Encoded;
    for (const options of [{}, { onExcessProperty: "error" as const }]) {
      expect(Schema.decodeUnknownSync(Public.LandofileAuthoringShape, options)(input)).toEqual(input);
      expect(Schema.decodeUnknownSync(Public.LandofileAuthoringFragment, options)(fragment)).toEqual(
        fragment,
      );
      expect(Schema.decodeUnknownSync(Public.LandofileShape, options)(input).services).toMatchObject({
        db: { healthcheck: false },
        web: { healthcheck: { kind: "command", command: "pg_isready" }, appMount: { target: "/site" } },
      });
    }
  });

  test("rejects invalid nested input refinements inside transformed service fields", () => {
    const invalidInputs = [
      { services: { web: { appMount: { target: "/site", excludes: ["!vendor"] } } } },
      { services: { web: { healthcheck: "" } } },
      { services: { web: { healthcheck: [] } } },
    ];
    for (const schema of [Public.LandofileAuthoringShape, Public.LandofileAuthoringFragment]) {
      for (const input of invalidInputs) {
        expect(
          Schema.decodeUnknownResult(Public.LandofileShape)(input, { onExcessProperty: "error" })._tag,
        ).toBe("Failure");
        expect(Schema.decodeUnknownResult(schema)(input, { onExcessProperty: "error" })._tag).toBe("Failure");
      }
    }
  });

  test.each([undefined, "warn" as const])(
    "validates a nested deprecation notice after its severity default (%s)",
    (severity) => {
      const input = {
        tooling: {
          old: {
            service: "web",
            cmd: "echo old",
            deprecated: {
              since: "4.0.0",
              note: "Use new instead.",
              ...(severity === undefined ? {} : { severity }),
            },
          },
        },
      };
      const options = { onExcessProperty: "error" as const };
      expect(Schema.decodeUnknownResult(Public.LandofileShape)(input, options)._tag).toBe("Failure");
      for (const schema of [Public.LandofileAuthoringShape, Public.LandofileAuthoringFragment]) {
        expect(Schema.decodeUnknownResult(schema)(input, options)._tag).toBe("Failure");
        expect(Schema.encodeUnknownResult(schema)(input, options)._tag).toBe("Failure");
      }
    },
  );

  test("keeps valid defaulted notices as authored input and round-trips runtime values strictly", () => {
    const input = {
      tooling: {
        old: {
          service: "web",
          cmd: "echo old",
          deprecated: { since: "4.2.0", note: "Use new instead." },
        },
      },
    };
    const options = { onExcessProperty: "error" as const };
    for (const schema of [Public.LandofileAuthoringShape, Public.LandofileAuthoringFragment]) {
      const authored = Schema.decodeUnknownSync(schema, options)(input);
      expect(authored).toEqual(input);
      expect(Schema.encodeSync(schema, options)(authored)).toEqual(input);
    }
    const runtime = Schema.decodeUnknownSync(Public.LandofileShape, options)(input);
    const encoded = Schema.encodeSync(Public.LandofileShape, options)(runtime);
    expect(Schema.decodeUnknownSync(Public.LandofileShape, options)(encoded)).toEqual(runtime);
  });

  test("defers an incomplete deprecation notice inside a fragment", () => {
    const input = { tooling: { old: { deprecated: { since: "4.0.0" } } } };
    expect(Schema.decodeUnknownResult(Public.LandofileAuthoringFragment)(input)._tag).toBe("Success");
  });

  test("validates notices after resolving merge directives only for a temporary check input", () => {
    const wire = Public.LandofileAuthoringFragment;
    const native = Public.LandofileAuthoringFragmentNative;
    const notice = (since: string, severity: unknown) => ({
      tooling: { old: { deprecated: { since, note: "Use new instead.", severity } } },
    });
    for (const [schema, replacement, removal, badReplacement] of [
      [
        wire,
        { _tag: "LandofileOverride", value: "warn" },
        { _tag: "LandofileReset" },
        { _tag: "LandofileOverride", value: "fatal" },
      ],
      [native, override("warn"), reset(), override("fatal")],
    ] as const) {
      expect(Schema.decodeUnknownResult(schema)(notice("4.2.0", replacement))._tag).toBe("Success");
      expect(Schema.decodeUnknownResult(schema)(notice("4.2.0", removal))._tag).toBe("Success");
      expect(Schema.decodeUnknownResult(schema)(notice("4.0.0", replacement))._tag).toBe("Failure");
      expect(Schema.decodeUnknownResult(schema)(notice("4.0.0", removal))._tag).toBe("Failure");
      expect(Schema.decodeUnknownResult(schema)(notice("4.2.0", badReplacement))._tag).toBe("Failure");
    }
  });
  const producer = {
    sourceKind: "bundled",
    packageName: "@lando/recipe-demo",
    manifestVersion: "1.0.0",
    contentDigest: `sha256:${"a".repeat(64)}`,
  } as const;
  const authoringDecoders = [
    ["complete shape", Schema.decodeUnknownResult(Public.LandofileAuthoringShape)],
    ["fragment", Schema.decodeUnknownResult(Public.LandofileAuthoringFragment)],
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
      expect(result._tag).toBe("Success");
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
      expect(result._tag).toBe("Failure");
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
      expect(result._tag).toBe("Failure");
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
      expect(result._tag).toBe("Failure");
    },
  );

  test("defers complete-object provenance semantics for an incomplete fragment", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringFragment)({
      recipe: { id: "demo" },
    });

    // Then
    expect(result._tag).toBe("Success");
  });

  test("rejects an expression at the complete Landofile root", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringShape)("{{ vars.landofile }}");

    // Then
    expect(result._tag).toBe("Failure");
  });

  test("keeps the complete Landofile root object-only without inventing required fields", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringShape)({});

    // Then
    expect(result).toMatchObject({ _tag: "Success", success: {} });
  });

  test("decodes a whole string expression without resolving it", () => {
    // Given
    const input = { name: '{{ env.X | default("a") }}' };
    // When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringShape)(input);
    // Then
    expect(Result.isSuccess(result)).toBe(true);
    if (Result.isFailure(result)) throw result.failure;
    expect(result.success).toMatchObject({
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
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringShape)(input);
    // Then
    expect(result).toMatchObject({
      _tag: "Success",
      success: { router: { httpPort: { expectedType: "number" } } },
    });
  });

  test.each([
    { router: { httpPort: "v{{ env.P }}" } },
    { router: { enabled: "{{ length(app.name) }}" } },
    { name: "{{ nope.x }}" },
    { name: "{{ frobnicate(env.X) }}" },
  ])("rejects invalid or incompatible expressions: %j", (input) => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringShape)(input);
    // Then
    expect(result._tag).toBe("Failure");
  });

  test("keeps a plain name as a string", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringShape)({ name: "plain" });
    // Then
    expect(result).toMatchObject({ _tag: "Success", success: { name: "plain" } });
  });

  test("accepts a missing nested required field in a fragment", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringFragment)({
      toolingIncludes: { shared: {} },
    });
    // Then
    expect(result._tag).toBe("Success");
  });

  test("requires a nested required field in a complete shape", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringShape)({
      toolingIncludes: { shared: {} },
    });
    // Then
    expect(result._tag).toBe("Failure");
  });

  test("accepts a service port expression in a fragment", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringFragment)({
      services: { web: { type: "lando", port: "{{ env.PORT }}" } },
    });
    // Then
    expect(result._tag).toBe("Success");
  });

  test("rejects runtime-only keys under strict excess-property handling", () => {
    // Given / When
    const result = Schema.decodeUnknownResult(Public.LandofileAuthoringFragment)(
      { appId: "x", plan: {} },
      { onExcessProperty: "error" },
    );
    // Then
    expect(result._tag).toBe("Failure");
  });

  test("suffixes nested identifiers in a fragment", () => {
    // Given
    const identifiers = new Set<string>();
    const seen = new Set<AST.AST>();
    const visit = (ast: AST.AST): void => {
      if (seen.has(ast)) return;
      seen.add(ast);
      const identifier = AST.resolveIdentifier(ast);
      if (identifier !== undefined) identifiers.add(identifier);
      for (const link of ast.encoding ?? []) visit(link.to);
      switch (ast._tag) {
        case "Objects":
          for (const property of ast.propertySignatures) visit(property.type);
          for (const index of ast.indexSignatures) visit(index.type);
          return;
        case "Union":
          ast.types.forEach(visit);
          return;
        case "Arrays":
          for (const element of [...ast.elements, ...ast.rest]) visit(element);
          return;
        case "Suspend":
          visit(ast.thunk());
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
    expect(identifiers.has("RouterConfigAuthoringFragment")).toBe(true);
  });

  test("keeps wire transport permissive where the validated shape rejects bad numbers", () => {
    // Given numeric literals outside the validated port and memory checks.
    const samples = [
      { router: { httpPort: 1.5 } },
      { router: { httpPort: 0 } },
      { router: { httpPort: 65536 } },
      { services: { web: { deploy: { resources: { limits: { memory: 1.5 } } } } } },
    ];

    // When each literal is decoded as validated authoring and as wire transport.
    const results = samples.map((input) => ({
      shape: Schema.decodeUnknownResult(Public.LandofileAuthoringShape)(input)._tag,
      wire: Schema.decodeUnknownResult(Public.LandofileAuthoringShapeWire)(input)._tag,
    }));

    // Then only the wire schema accepts them.
    expect(results).toEqual(samples.map(() => ({ shape: "Failure", wire: "Success" })));
  });

  test("publishes deprecation constraints without requiring them on a partial fragment", () => {
    // Given the published authoring documents.
    const shape = getJsonSchema("LandofileAuthoringShape");
    const fragment = getJsonSchema("LandofileAuthoringFragment");

    // When a fragment omits the notice fields the published schema still lists.
    const decoded = Schema.decodeUnknownResult(Public.LandofileAuthoringFragment)({
      tooling: { task: { service: "web", cmd: "echo", deprecated: { since: "4.2.0" } } },
    });

    // Then the JSON projection keeps the notice contract and the fragment stays partial.
    expect(shape).toMatchObject({
      $defs: {
        DeprecationNotice: {
          required: ["since", "note"],
          properties: {
            docsUrl: { format: "uri", pattern: "^[Hh][Tt][Tt][Pp][Ss]?://" },
            since: { pattern: "^(0|[1-9]\\d*)\\.(0|[1-9]\\d*)\\.(0|[1-9]\\d*)$" },
            severity: { enum: ["info", "warn", "error"] },
          },
        },
      },
    });
    expect(fragment).toMatchObject({ $defs: { DeprecationNotice: { required: ["since", "note"] } } });
    for (const [document, taskDefinition] of [
      [shape, "ToolingTaskInputAuthoring"],
      [fragment, "ToolingTaskInputAuthoringFragment"],
    ] as const) {
      expect(document).toHaveProperty(["$defs", "DeprecationNotice", "required"], ["since", "note"]);
      const definitions = document.$defs;
      if (typeof definitions !== "object" || definitions === null) {
        throw new TypeError("Expected JSON Schema definitions");
      }
      expect(JSON.stringify(Reflect.get(definitions, taskDefinition))).toContain(
        '"$ref":"#/$defs/DeprecationNotice"',
      );
    }
    expect(shape).toHaveProperty(["properties", "tooling", "anyOf", 0, "additionalProperties"], {
      $ref: "#/$defs/ToolingTaskInputAuthoring",
    });
    expect(shape).toHaveProperty(
      ["$defs", "ToolingTaskInputAuthoring", "anyOf", 0, "anyOf", 0, "properties", "deprecated", "anyOf"],
      [{ $ref: "#/$defs/DeprecationNotice" }, { type: "string", pattern: expect.any(String) }],
    );
    expect(decoded._tag).toBe("Success");
  });
});
