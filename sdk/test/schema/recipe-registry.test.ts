import { describe, expect, test } from "bun:test";
import { Result, Schema } from "effect";

import { RecipeRegistryResolution, RecipeRegistryResponse } from "@lando/sdk/schema";

describe("RecipeRegistryResolution", () => {
  test("decodes a valid git resolution", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResolution)({
      kind: "git",
      url: "https://example.test/repo.git",
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("decodes a valid git resolution with path", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResolution)({
      kind: "git",
      url: "https://example.test/repo.git",
      path: "packages/foo",
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("decodes a valid tarball resolution", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResolution)({
      kind: "tarball",
      url: "https://example.test/r.tgz",
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("decodes a valid tarball resolution with path and checksum", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResolution)({
      kind: "tarball",
      url: "https://example.test/r.tgz",
      path: "packages/foo",
      checksum: "sha256-deadbeef",
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("rejects an invalid resolution kind", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResolution)({
      kind: "svn",
      url: "https://example.test/repo",
    });

    expect(Result.isFailure(result)).toBe(true);
  });

  test("rejects a resolution missing url", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResolution)({
      kind: "git",
    });

    expect(Result.isFailure(result)).toBe(true);
  });
});

describe("RecipeRegistryResponse", () => {
  test("decodes a valid response", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResponse)({
      resolution: { kind: "git", url: "https://example.test/repo.git" },
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("decodes a valid response with optional id", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResponse)({
      id: "drupal-10",
      resolution: { kind: "tarball", url: "https://example.test/r.tgz" },
    });

    expect(Result.isSuccess(result)).toBe(true);
  });

  test("rejects a response missing resolution", () => {
    const result = Schema.decodeUnknownResult(RecipeRegistryResponse)({
      id: "x",
    });

    expect(Result.isFailure(result)).toBe(true);
  });
});
