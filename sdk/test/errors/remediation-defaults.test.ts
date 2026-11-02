import { expect, test } from "bun:test";
import { Schema } from "effect";

import {
  AppIdReservedError,
  GlobalAutoStartError,
  GuideFixtureNotFoundError,
  GuideFixtureSymlinkError,
  LandofileNotFoundError,
  RecipeManifestNotFoundError,
  RecipeManifestValidationError,
} from "@lando/sdk/errors";

function override(remediation: string | undefined) {
  return remediation === undefined ? {} : { remediation };
}

const constructors = [
  (remediation?: string) => new AppIdReservedError({ reserved: "global", ...override(remediation) }),
  (remediation?: string) =>
    new GlobalAutoStartError({
      message: "Global start failed.",
      app: "web",
      services: ["router"],
      ...override(remediation),
    }),
  (remediation?: string) =>
    new GuideFixtureNotFoundError({
      message: "Missing fixture.",
      fixtureName: "web",
      candidates: ["fixtures/web"],
      ...override(remediation),
    }),
  (remediation?: string) =>
    new GuideFixtureSymlinkError({
      message: "Symlink fixture.",
      fixtureName: "web",
      path: "fixtures/web",
      ...override(remediation),
    }),
  (remediation?: string) =>
    new LandofileNotFoundError({ message: "Missing Landofile.", cwd: "/project", ...override(remediation) }),
  (remediation?: string) =>
    new RecipeManifestNotFoundError({
      message: "Missing manifest.",
      source: "/recipe",
      ...override(remediation),
    }),
  (remediation?: string) =>
    new RecipeManifestValidationError({
      message: "Invalid manifest.",
      source: "/recipe/recipe.yml",
      issues: [{ path: ["id"], message: "Invalid id." }],
      ...override(remediation),
    }),
];

for (const construct of constructors) {
  const name = construct()._tag;
  test(`${name} supplies its action when the constructor omits remediation`, () => {
    // Given a defaulted error; when constructing and encoding without an override.
    const error = construct();
    // Then the action is present on the decoded value and on the wire.
    expect(error.remediation.trim().length).toBeGreaterThan(0);
    expect(Schema.encodeSync(Schema.Struct({ remediation: Schema.String }))(error)).toEqual({
      remediation: error.remediation,
    });
  });

  test(`${name} preserves a caller's more specific action`, () => {
    // Given an action distinct from the default; when constructing the error.
    const action = "Edit /project/custom.yml to resolve this specific failure.";
    const error = construct(action);
    // Then the caller's recovery instruction takes precedence.
    expect(error.remediation).toBe(action);
  });

  test(`${name} rejects blank constructor overrides`, () => {
    // Given blank overrides; when constructing, then validation rejects them.
    for (const action of ["", " ", "\t\n"]) expect(() => construct(action)).toThrow();
  });
}
