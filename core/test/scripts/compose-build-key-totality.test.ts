import { SchemaIssue } from "effect";
import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import { BuildBlock } from "@lando/sdk/schema";

import { composeServiceDispositions } from "@lando/sdk/landofile";

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
        const result = Schema.decodeUnknownResult(BuildBlock)(input, options);
        expect(Result.isFailure(result)).toBe(true);
        if (!Result.isFailure(result)) continue;
        const message = SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue).issues
          .map(({ message }) => message)
          .join("\n");
        expect(message).toContain(authoredKey);
        expect(message).toContain("mixes two key families");
        expect(message).toContain("Compose image-build keys");
        expect(message).toContain("Lando build-script keys");
        expect(message).toContain("image:");

        const composeOnlyResult = Schema.decodeUnknownResult(BuildBlock)(
          { [authoredKey]: buildValue(matrixKey) },
          options,
        );
        expect(Result.isSuccess(composeOnlyResult)).toBe(disposition === "normalized");
        if (disposition === "rejected" && Result.isFailure(composeOnlyResult)) {
          const rejectedMessage = SchemaIssue.makeFormatterStandardSchemaV1()(composeOnlyResult.failure.issue).issues
            .map(({ message: issue }) => issue)
            .join("\n");
          expect(rejectedMessage).toContain(authoredKey);
        }
      }
    }
  });
});
