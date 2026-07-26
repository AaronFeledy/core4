import { describe, expect, test } from "bun:test";
import { Either, ParseResult, Schema } from "effect";

import { BuildBlock, LandofileShape, ServiceConfig } from "../../src/schema/landofile.ts";

const decodeOptions = [{}, { onExcessProperty: "error" }] as const;

const expectAccepted = (input: unknown, expected: typeof BuildBlock.Type): void => {
  const decoded = [
    ...decodeOptions.map((options) => Schema.decodeUnknownSync(BuildBlock)(input, options)),
    ...decodeOptions.map(
      (options) => Schema.decodeUnknownSync(ServiceConfig)({ build: input }, options).build,
    ),
  ];

  for (const value of decoded) expect(value).toEqual(expected);
};

const expectLandofileFailure = (input: unknown, fragments: ReadonlyArray<string>): void => {
  const results: ReadonlyArray<Either.Either<unknown, ParseResult.ParseError>> = [
    ...decodeOptions.map((options) => Schema.decodeUnknownEither(BuildBlock)(input, options)),
    ...decodeOptions.map((options) => Schema.decodeUnknownEither(ServiceConfig)({ build: input }, options)),
  ];

  for (const result of results) {
    expect(Either.isLeft(result)).toBe(true);
    if (!Either.isLeft(result)) continue;
    const message = ParseResult.ArrayFormatter.formatErrorSync(result.left).find(({ message }) =>
      message.startsWith("Landofile service"),
    )?.message;
    expect(message?.startsWith("Landofile service")).toBe(true);
    for (const fragment of fragments) expect(message).toContain(fragment);
  }
};

describe("BuildBlock", () => {
  test('defaults context to "." for a Compose family block', () => {
    // Given
    const input = { dockerfile: "Dockerfile" };

    // When / Then
    expectAccepted(input, { context: ".", dockerfile: "Dockerfile" });
  });

  test("accepts the bare string short form as context", () => {
    // Given
    const input = "./docker";

    // When / Then
    expectAccepted(input, { context: "./docker" });
  });

  test("canonicalizes the args list form splitting on the first =", () => {
    // Given
    const input = { context: ".", args: ["FOO=bar=baz"] };

    // When / Then
    expectAccepted(input, { context: ".", args: { FOO: "bar=baz" } });
  });

  test("rejects a bare args list entry", () => {
    // Given / When / Then
    expectLandofileFailure({ context: ".", args: ["FOO"] }, ["FOO"]);
  });

  test("rejects a null args map value", () => {
    // Given / When / Then
    expectLandofileFailure({ context: ".", args: { FOO: null } }, ["build.args.FOO"]);
  });

  test("rejects dockerfile together with dockerfile_inline", () => {
    // Given / When / Then
    expectLandofileFailure({ context: ".", dockerfile: "Dockerfile", dockerfile_inline: "FROM alpine" }, [
      "dockerfile",
      "dockerfile_inline",
    ]);
  });

  test("rejects an empty build block", () => {
    // Given / When / Then
    expectLandofileFailure({}, [
      'Landofile service "build" is empty.',
      "Compose image-build keys",
      "Lando build-script keys",
    ]);
  });

  test("fails a mixed family block naming both families and the offending keys", () => {
    // Given / When / Then
    expectLandofileFailure({ context: ".", app: ["echo"] }, [
      "context",
      "app",
      "Compose",
      "Lando build-script",
      "remove",
    ]);
  });

  test("fails every mixed Lando and rejected Compose build-key shape before excess keys can be dropped", () => {
    // Given
    const fixtures = [
      { input: { artifact: "x", no_cache: true }, keys: ["artifact", "no_cache"] },
      { input: { app: "x", platforms: ["linux/amd64"] }, keys: ["app", "platforms"] },
      { input: { artifact: "x", "x-builder": { mode: "fast" } }, keys: ["artifact", "x-builder"] },
      {
        input: { artifact: "x", app: "x", no_cache: true, platforms: [], "x-builder": true },
        keys: ["artifact", "app", "no_cache", "platforms", "x-builder"],
      },
    ] as const;

    for (const { input, keys } of fixtures) {
      // When / Then
      expectLandofileFailure(input, [...keys, "Compose", "Lando build-script", "image:"]);
      for (const options of decodeOptions) {
        const result = Schema.decodeUnknownEither(BuildBlock)(input, options);
        expect(Either.isLeft(result)).toBe(true);
        if (!Either.isLeft(result)) continue;
        const message = ParseResult.ArrayFormatter.formatErrorSync(result.left)
          .map(({ message }) => message)
          .join("\n");
        expect(message).not.toContain("build.dockerfile");
      }
    }
  });

  test("fails closed for unsupported Compose-only build keys under default and strict decode", () => {
    // Given
    const fixtures = [
      { no_cache: true },
      { platforms: ["linux/amd64"] },
      { "x-builder": { mode: "fast" } },
    ] as const;

    for (const input of fixtures) {
      for (const options of decodeOptions) {
        // When
        const result = Schema.decodeUnknownEither(BuildBlock)(input, options);

        // Then
        expect(Either.isLeft(result)).toBe(true);
        if (!Either.isLeft(result)) continue;
        expect(ParseResult.isParseError(result.left)).toBe(true);
        const message = ParseResult.ArrayFormatter.formatErrorSync(result.left)
          .map(({ message }) => message)
          .join("\n");
        expect(message).not.toContain("Translate build.");
        expect(message).not.toContain("ComposeKeyRejectedError");
      }
    }
  });

  test("rejects mixed families at the Landofile authoring boundary under default and strict decode", () => {
    // Given
    const input = {
      name: "app",
      services: { web: { build: { artifact: "x", no_cache: true } } },
    };

    for (const options of decodeOptions) {
      // When
      const result = Schema.decodeUnknownEither(LandofileShape)(input, options);

      // Then
      expect(Either.isLeft(result)).toBe(true);
      if (!Either.isLeft(result)) continue;
      const message = ParseResult.ArrayFormatter.formatErrorSync(result.left)
        .map(({ message }) => message)
        .join("\n");
      expect(message).toContain("artifact");
      expect(message).toContain("no_cache");
      expect(message).toContain("image:");
      expect(message).not.toContain("build.dockerfile");
    }
  });

  test("decodes a Lando family block", () => {
    // Given
    const input = { app: "echo hi" };

    // When
    const decoded = Schema.decodeUnknownSync(BuildBlock)(input);

    // Then
    expectAccepted(input, { app: "echo hi" });
    expect("context" in decoded).toBe(false);
  });

  test("decode(decode(x)) equals decode(x) under default and strict options", () => {
    // Given
    const fixtures = [
      { context: "./docker", dockerfile: "Containerfile", args: { FOO: "bar" }, target: "release" },
      { context: ".", dockerfile_inline: "FROM alpine" },
      "./docker",
      { artifact: ["echo artifact"], app: "echo app" },
    ] as const;

    for (const fixture of fixtures) {
      for (const options of decodeOptions) {
        // When
        const decoded = Schema.decodeUnknownSync(BuildBlock)(fixture, options);
        const decodedAgain = Schema.decodeUnknownSync(BuildBlock)(decoded, options);
        const serviceDecoded = Schema.decodeUnknownSync(ServiceConfig)({ build: fixture }, options).build;

        // Then
        expect(decodedAgain).toEqual(decoded);
        expect(serviceDecoded).toEqual(decoded);
      }
    }
  });

  test("the canonical union is structurally exclusive", () => {
    // Given
    const BuildBlockCanonical = Schema.typeSchema(BuildBlock);

    // When / Then
    expect(() => Schema.decodeUnknownSync(BuildBlockCanonical)({ artifact: ["x"], context: "." })).toThrow();
    expect(
      Schema.decodeUnknownSync(BuildBlockCanonical)({ context: "." }, { onExcessProperty: "ignore" }),
    ).toEqual({ context: "." });
  });

  test("encodes dockerfileInline back to dockerfile_inline", () => {
    // Given
    const canonical = { context: ".", dockerfileInline: "FROM alpine" };

    // When
    const encoded = Schema.encodeSync(BuildBlock)(canonical);

    // Then
    expect(encoded).toEqual({ context: ".", dockerfile_inline: "FROM alpine" });
  });

  test("ServiceConfig no longer accepts composeBuild", () => {
    // Given / When
    const result = Schema.decodeUnknownEither(ServiceConfig)(
      { type: "compose", composeBuild: { context: "." } },
      { onExcessProperty: "error" },
    );

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(String(result.left)).toContain("composeBuild");
  });
});
