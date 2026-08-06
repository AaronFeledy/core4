import { describe, expect, test } from "bun:test";
import { Either, ParseResult, Schema } from "effect";

import { BuildBlock } from "@lando/sdk/schema";

import { composeServiceDispositions } from "@lando/landofile/compose/dispositions";

const supportedBuildKeys = ["args", "context", "dockerfile", "dockerfile_inline", "target"] as const;
const decodeOptions = [{}, { onExcessProperty: "error" }] as const;

const buildValue = (key: string): unknown => {
  switch (key) {
    case "args":
      return { FOO: "bar" };
    case "context":
      return ".";
    case "dockerfile":
      return "Dockerfile";
    case "dockerfile_inline":
      return "FROM scratch";
    case "target":
      return "release";
    default:
      return true;
  }
};

describe("Compose build-key totality", () => {
  test("every vendored depth-1 build key participates in mixed-family detection", () => {
    // Given
    const depthOneDispositions = Object.entries(composeServiceDispositions)
      .filter(([path]) => /^build\.[^.]+$/u.test(path))
      .map(([path, entry]) => [path.slice("build.".length), entry.disposition] as const);
    const supportedKeySet = new Set<string>(supportedBuildKeys);

    // When
    const normalizedKeys = depthOneDispositions
      .filter(([, disposition]) => disposition === "normalized")
      .map(([key]) => key)
      .sort();
    const rejectedKeys = depthOneDispositions
      .filter(([, disposition]) => disposition === "rejected")
      .map(([key]) => key)
      .sort();

    // Then
    expect(normalizedKeys).toEqual([...supportedBuildKeys].sort());
    expect(rejectedKeys).toEqual(
      depthOneDispositions
        .map(([key]) => key)
        .filter((key) => !supportedKeySet.has(key))
        .sort(),
    );
    expect(depthOneDispositions.some(([, disposition]) => disposition === "preserved")).toBe(false);

    for (const [matrixKey, disposition] of depthOneDispositions) {
      const authoredKey = matrixKey === "x-*" ? "x-totality" : matrixKey;
      const input = { artifact: "x", [authoredKey]: buildValue(matrixKey) };
      for (const options of decodeOptions) {
        const result = Schema.decodeUnknownEither(BuildBlock)(input, options);
        expect(Either.isLeft(result)).toBe(true);
        if (!Either.isLeft(result)) continue;
        const message = ParseResult.ArrayFormatter.formatErrorSync(result.left)
          .map(({ message }) => message)
          .join("\n");
        expect(message).toContain(authoredKey);
        expect(message).toContain("mixes two key families");
        expect(message).toContain("Compose image-build keys");
        expect(message).toContain("Lando build-script keys");
        expect(message).toContain("image:");

        const composeOnlyResult = Schema.decodeUnknownEither(BuildBlock)(
          { [authoredKey]: buildValue(matrixKey) },
          options,
        );
        expect(Either.isRight(composeOnlyResult)).toBe(disposition === "normalized");
        if (disposition === "rejected" && Either.isLeft(composeOnlyResult)) {
          const rejectedMessage = ParseResult.ArrayFormatter.formatErrorSync(composeOnlyResult.left)
            .map(({ message: issue }) => issue)
            .join("\n");
          expect(rejectedMessage).toContain(authoredKey);
        }
      }
    }
  });
});
