import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";
import { Cause, Effect, Exit, Option } from "effect";

import { LandofileValidationError } from "@lando/sdk/errors";
import { formatValidationIssuePath } from "@lando/sdk/schema";

import { loadLandofileFile } from "../src/service.ts";
import { landofileValidationError, validateLandofile } from "../src/validation.ts";

describe("Landofile validation issues", () => {
  test("retains remediation as a machine field rather than only message text", () => {
    // Given
    const framing = {
      headline: "Invalid port",
      remediation: "Set services.web.port to a number, or remove the local override.",
    };
    // When
    const result = landofileValidationError(
      "/app/.lando.yml",
      [{ path: ["services", "web", "port"], message: "Expected number." }],
      framing,
    );
    // Then
    expect(result).toHaveProperty("remediation", framing.remediation);
    expect(result.message).not.toContain(framing.remediation);
  });

  test("uses the primary issue's authored source as the top-level error file", () => {
    // Given
    const source = {
      file: "/app/.lando.local.yml",
      layer: "local" as const,
      path: ["services", "web", "port"],
    };
    // When
    const result = landofileValidationError("/app/.lando.yml", [
      { path: source.path, message: "Expected number.", source },
    ]);
    // Then
    expect(result.file).toBe(source.file);
    expect(result.issues[0]).toHaveProperty("source", source);
  });

  test("preserves the closest-key suggestion when an unknown key contains a planner expression", async () => {
    // Given
    const root = await mkdtemp(join(tmpdir(), "lando-unknown-planner-key-"));
    const file = join(root, ".lando.yml");
    try {
      await writeFile(file, 'name: typo\nservices:\n  web:\n    primry: "{{ app.name }}"\n');
      // When
      const result = await Effect.runPromise(loadLandofileFile(file).pipe(Effect.result));
      // Then
      if (result._tag !== "Failure" || result.failure._tag !== "LandofileValidationError") {
        throw new Error("Expected Landofile validation failure");
      }
      expect(result.failure.issues).toContainEqual(
        expect.objectContaining({
          path: ["services", "web", "primry"],
          suggestion: 'Did you mean "primary"?',
        }),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test.each([
    [{ services: { web: { primary: "maybe" } } }, "invalid values"],
    [{ services: { web: { primary: "maybe", imgae: "node" } } }, "unknown keys and invalid values"],
    [{ services: { web: { imgae: "node" } } }, "unknown keys"],
  ])("classifies schema issues for %j", async (value, headline) => {
    // Given / When
    const error = await Effect.runPromise(validateLandofile("/app/.lando.yml", value).pipe(Effect.flip));
    // Then
    expect(error.message).toContain(headline);
    expect(error.message).not.toContain("MVP");
    expect(error.message).not.toContain("Remove unsupported keys");
    expect(error.message).not.toContain("?.");
    expect(error.message).not.toContain("..");
  });

  test("joins issue sentences without doubled periods or question-period endings", () => {
    // Given
    const issues = [
      { path: ["a"], message: "Bad value." },
      { path: ["imgae"], message: "Unknown key.", suggestion: 'Did you mean "image"?' },
    ];
    // When
    const result = landofileValidationError("/app/.lando.yml", issues);
    // Then
    expect(result.message).toBe(
      'Landofile has invalid values: a: Bad value; imgae: Unknown key. Did you mean "image"?',
    );
    expect(result.message).not.toContain("?.");
    expect(result.message).not.toContain("..");
  });
  test("reports three independent problems with paths and an image suggestion", async () => {
    const appRoot = await mkdtemp(join(tmpdir(), "lando-validation-issues-"));
    const file = join(appRoot, ".lando.yml");
    try {
      await writeFile(
        file,
        [
          "name: config-lint-invalid",
          "services:",
          "  web:",
          "    type: compose",
          "    imgae: nginx:1.27-alpine",
          '    home: "nope"',
          "    ports:",
          "      - target: 99999",
          "        protocol: tcp",
          "",
        ].join("\n"),
      );
      const exit = await Effect.runPromiseExit(loadLandofileFile(file));
      expect(Exit.isFailure(exit)).toBe(true);
      if (!Exit.isFailure(exit)) return;
      const failure = Cause.findErrorOption(exit.cause);
      expect(Option.isSome(failure)).toBe(true);
      if (!Option.isSome(failure) || !(failure.value instanceof LandofileValidationError)) {
        throw new Error("expected LandofileValidationError");
      }
      const paths = failure.value.issues.map((issue) => formatValidationIssuePath(issue.path));
      expect(paths).toContain("services.web.imgae");
      expect(paths).toContain("services.web.home");
      expect(paths).toContain("services.web.ports[0].target");
      expect(failure.value.issues.find((issue) => issue.path.at(-1) === "imgae")?.suggestion).toBe(
        'Did you mean "image"?',
      );
    } finally {
      await rm(appRoot, { recursive: true, force: true });
    }
  });
});
