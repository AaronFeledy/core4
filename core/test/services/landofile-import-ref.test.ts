import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "bun:test";
import { Effect } from "effect";

import { LandofileImportRefMisuseError } from "@lando/sdk/errors";

import { resolveLandofileLoadExpressions } from "@lando/landofile/load-expression";
import { PEM, discoverFailure, withApp } from "./landofile-load-expression-support.ts";

const ACCEPTING_KEYS = ["ca", "cas", "certificate-authority", "certificate-authorities"] as const;
const ACCEPTING_KEY_CASES = ACCEPTING_KEYS.map((key) => [key] as const);

test.each(ACCEPTING_KEY_CASES)("accepts an ImportRef at scalar services security %s", async (key) => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "corp.pem"), PEM);

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileLoadExpressions({
        value: { services: { web: { security: { [key]: "{{ import('./corp.pem') }}" } } } },
        source: {
          appRoot,
          sourcePath: join(appRoot, ".lando.yml"),
          sourceRoot: appRoot,
          layer: "canonical",
        },
        policy: {
          allowOutsideRoot: false,
          maxFileBytes: 1_048_576,
          maxFilesPerExpression: 16,
          maxRecursionDepth: 4,
        },
      }),
    );

    // Then
    expect(resolved.value).toMatchObject({
      services: { web: { security: { [key]: { _tag: "ImportRef", value: PEM } } } },
    });
  });
});

test.each(ACCEPTING_KEY_CASES)("accepts an ImportRef in list services security %s", async (key) => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "corp.pem"), PEM);

    // When
    const resolved = await Effect.runPromise(
      resolveLandofileLoadExpressions({
        value: { services: { web: { security: { [key]: ["{{ import('./corp.pem') }}"] } } } },
        source: {
          appRoot,
          sourcePath: join(appRoot, ".lando.yml"),
          sourceRoot: appRoot,
          layer: "canonical",
        },
        policy: {
          allowOutsideRoot: false,
          maxFileBytes: 1_048_576,
          maxFilesPerExpression: 16,
          maxRecursionDepth: 4,
        },
      }),
    );

    // Then
    expect(resolved.value).toMatchObject({
      services: { web: { security: { [key]: [{ _tag: "ImportRef", value: PEM }] } } },
    });
  });
});

test("rejects an ImportRef at a non-accepting key", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    environment:",
        "      BAD: \"{{ import('./corp.pem') }}\"",
        "",
      ].join("\n"),
    );

    // When
    const failure = await discoverFailure();

    // Then
    expect(failure).toBeInstanceOf(LandofileImportRefMisuseError);
  });
});

test("rejects a nested ImportRef produced at a non-accepting key", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    environment:",
        "      BAD: \"{{ { nested: import('./corp.pem') } }}\"",
        "",
      ].join("\n"),
    );

    // When
    const failure = await discoverFailure();

    // Then
    expect(failure).toBeInstanceOf(LandofileImportRefMisuseError);
    expect(failure).toMatchObject({ configPath: "services.web.environment.BAD.nested" });
  });
});

test("rejects a nested ImportRef after an accepted CA list item", async () => {
  await withApp(async (appRoot) => {
    // Given
    await writeFile(join(appRoot, "corp.pem"), PEM);
    await writeFile(
      join(appRoot, ".lando.yml"),
      [
        "name: trust-app",
        "services:",
        "  web:",
        "    security:",
        "      ca: \"{{ [import('./corp.pem'), { nested: import('./corp.pem') }] }}\"",
        "",
      ].join("\n"),
    );

    // When
    const failure = await discoverFailure();

    // Then
    expect(failure).toBeInstanceOf(LandofileImportRefMisuseError);
    expect(failure).toMatchObject({ configPath: "services.web.security.ca.1.nested" });
  });
});
