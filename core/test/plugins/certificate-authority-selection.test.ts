import { describe, expect, test } from "bun:test";

import { Either } from "effect";

import { AmbiguousCertificateAuthoritiesError, NoCertificateAuthorityError } from "@lando/sdk/errors";

import {
  type CertificateAuthorityCandidateDefinition,
  selectCertificateAuthorityCandidate,
} from "../../src/plugins/certificate-authority-resolver.ts";

const candidate = (
  id: string,
  source: string,
  platforms?: ReadonlyArray<string>,
): CertificateAuthorityCandidateDefinition => ({
  id,
  pluginName: `@example/${id}`,
  source,
  ...(platforms === undefined ? {} : { defaultFor: { platform: platforms } }),
  acquire: undefined,
});

describe("selectCertificateAuthorityCandidate", () => {
  test("returns a tagged absent error when no candidate exists", () => {
    // Given
    const candidates: ReadonlyArray<CertificateAuthorityCandidateDefinition> = [];

    // When
    const result = selectCertificateAuthorityCandidate(candidates, "linux");

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(NoCertificateAuthorityError);
  });

  test("selects the sole candidate when no defaultFor matcher applies", () => {
    // Given
    const only = candidate("only", "plugins.layers[0]");

    // When
    const result = selectCertificateAuthorityCandidate([only], "linux");

    // Then
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe(only);
  });

  test("selects the unique platform default over raw and non-default manifest candidates", () => {
    // Given
    const raw = candidate("raw", "plugins.layers[0]");
    const fallback = candidate("fallback", "user");
    const selected = candidate("default", "bundled", ["linux"]);

    // When
    const result = selectCertificateAuthorityCandidate([raw, fallback, selected], "linux");

    // Then
    expect(Either.isRight(result)).toBe(true);
    if (Either.isRight(result)) expect(result.right).toBe(selected);
  });

  test("returns tagged ambiguity for multiple platform defaults", () => {
    // Given
    const candidates = [candidate("first", "bundled", ["linux"]), candidate("second", "user", ["linux"])];

    // When
    const result = selectCertificateAuthorityCandidate(candidates, "linux");

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(AmbiguousCertificateAuthoritiesError);
      expect(result.left.candidates.map(({ id }) => id)).toEqual(["first", "second"]);
    }
  });

  test("returns tagged ambiguity for raw plus a non-default manifest candidate", () => {
    // Given
    const candidates = [candidate("raw", "plugins.layers[0]"), candidate("manifest", "explicit")];

    // When
    const result = selectCertificateAuthorityCandidate(candidates, "linux");

    // Then
    expect(Either.isLeft(result)).toBe(true);
    if (Either.isLeft(result)) expect(result.left).toBeInstanceOf(AmbiguousCertificateAuthoritiesError);
  });
});
