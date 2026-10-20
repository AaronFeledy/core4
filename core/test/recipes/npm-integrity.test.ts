import { expect, test } from "bun:test";
import { verifyNpmPackageDistIntegrity } from "../../src/recipes/npm-source.ts";

test("recipe integrity wrapper keeps accepting unverifiable metadata", () => {
  // Given
  const bytes = new TextEncoder().encode("archive");
  // When / Then
  expect(() =>
    verifyNpmPackageDistIntegrity(bytes, { tarball: "https://example.test/pkg.tgz" }, "recipe-package"),
  ).not.toThrow();
});

test("recipe integrity wrapper retains its tagged error and remediation", () => {
  // Given
  const bytes = new TextEncoder().encode("tampered");
  // When / Then
  expect(() =>
    verifyNpmPackageDistIntegrity(
      bytes,
      { tarball: "https://example.test/pkg.tgz", integrity: "sha512-wrong" },
      "recipe-package",
    ),
  ).toThrow(
    expect.objectContaining({
      _tag: "RecipeSourceError",
      kind: "integrity-mismatch",
      source: "recipe-package",
      message: "npm tarball recipe-package failed sha512 integrity verification.",
      remediation:
        "The downloaded tarball does not match the registry integrity; retry or report the package.",
    }),
  );
});
