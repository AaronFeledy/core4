import { Either, Schema } from "effect";

import { RecipeRegistryResolution, RecipeRegistryResponse } from "@lando/sdk/schema";

describe("RecipeRegistryResolution", () => {
  test("decodes a valid git resolution", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResolution)({
      kind: "git",
      url: "https://example.test/repo.git",
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("decodes a valid git resolution with path", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResolution)({
      kind: "git",
      url: "https://example.test/repo.git",
      path: "packages/foo",
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("decodes a valid tarball resolution", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResolution)({
      kind: "tarball",
      url: "https://example.test/r.tgz",
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("decodes a valid tarball resolution with path and checksum", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResolution)({
      kind: "tarball",
      url: "https://example.test/r.tgz",
      path: "packages/foo",
      checksum: "sha256-deadbeef",
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("rejects an invalid resolution kind", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResolution)({
      kind: "svn",
      url: "https://example.test/repo",
    });

    expect(Either.isLeft(result)).toBe(true);
  });

  test("rejects a resolution missing url", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResolution)({
      kind: "git",
    });

    expect(Either.isLeft(result)).toBe(true);
  });
});

describe("RecipeRegistryResponse", () => {
  test("decodes a valid response", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResponse)({
      resolution: { kind: "git", url: "https://example.test/repo.git" },
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("decodes a valid response with optional id", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResponse)({
      id: "drupal-10",
      resolution: { kind: "tarball", url: "https://example.test/r.tgz" },
    });

    expect(Either.isRight(result)).toBe(true);
  });

  test("rejects a response missing resolution", () => {
    const result = Schema.decodeUnknownEither(RecipeRegistryResponse)({
      id: "x",
    });

    expect(Either.isLeft(result)).toBe(true);
  });
});
