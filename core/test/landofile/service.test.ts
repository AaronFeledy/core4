import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { LandofileValidationError } from "@lando/core/errors";
import { LandofileService } from "@lando/core/services";
import * as TestLandofileServiceLayer from "../_support/landofile-layer.ts";

const withTempCwd = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-landofile-service-boundary-"));
  const previousCwd = process.cwd();
  try {
    return await run(dir);
  } finally {
    process.chdir(previousCwd);
    await rm(dir, { recursive: true, force: true });
  }
};

const discoverExit = () =>
  Effect.runPromiseExit(
    Effect.flatMap(LandofileService, (landofileService) => landofileService.discover).pipe(
      Effect.provide(TestLandofileServiceLayer.layer),
    ),
  );

const validationErrorFrom = (exit: Exit.Exit<unknown, unknown>): LandofileValidationError => {
  expect(Exit.isFailure(exit)).toBe(true);
  if (!Exit.isFailure(exit)) {
    throw new Error("expected Landofile discovery to fail");
  }
  const failure = Cause.findErrorOption(exit.cause);
  expect(failure._tag).toBe("Some");
  if (failure._tag !== "Some") {
    throw new Error("expected a typed failure cause");
  }
  if (!(failure.value instanceof LandofileValidationError)) {
    throw new Error("expected LandofileValidationError");
  }
  return failure.value;
};

describe("LandofileService layer — build shape discrimination boundary", () => {
  test("a rejected Compose build key still reaches mixed-family remediation at the loader boundary", async () => {
    await withTempCwd(async (dir) => {
      // Given: a service build block that mixes a rejected Compose key with the Lando family
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    image: node:lts",
          "    build:",
          "      artifact: echo hi",
          "      no_cache: true",
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      // When
      const error = validationErrorFrom(await discoverExit());

      // Then: validationIssues keeps the schema remediation, not the dotted path
      expect(error._tag).toBe("LandofileValidationError");
      const mixedIssue = error.issues.find((issue) => issue.message.startsWith("Landofile service"));
      expect(mixedIssue).toBeDefined();
      expect(mixedIssue?.message.startsWith("Landofile service")).toBe(true);
      expect(mixedIssue?.message).toContain("Compose");
      expect(mixedIssue?.message).toContain("Lando build-script");
      expect(mixedIssue?.message).toContain("artifact");
      expect(mixedIssue?.message).toContain("no_cache");
      expect(mixedIssue?.message).toContain("remove");
      expect(mixedIssue?.message).toContain("image:");
      expect(mixedIssue?.message).not.toContain("build.dockerfile");
      expect(mixedIssue?.message).not.toBe("services.web.build");
    });
  });

  test("a rejected composeBuild key surfaces as an unknown key issue", async () => {
    await withTempCwd(async (dir) => {
      // Given: the deleted composeBuild field still authored on a service
      await writeFile(
        join(dir, ".lando.yml"),
        [
          "name: myapp",
          "services:",
          "  web:",
          "    image: node:lts",
          "    composeBuild:",
          '      context: "."',
          "",
        ].join("\n"),
      );
      process.chdir(dir);

      // When
      const error = validationErrorFrom(await discoverExit());

      // Then: merged strict-decode (onExcessProperty: error) reports the unknown key
      expect(
        error.issues.some(
          (issue) => issue.message.includes("composeBuild") || issue.path.includes("composeBuild"),
        ),
      ).toBe(true);
    });
  });
});
