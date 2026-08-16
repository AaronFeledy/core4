import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cause, Effect, Exit } from "effect";

import { ComposeKeyRejectedError, LandofileParseError, LandofileValidationError } from "@lando/sdk/errors";
import { loadLandofileFile, loadLandofileLayers } from "../../src/services/landofile-live";
import { composeServiceDispositions, composeTagDispositions } from "@lando/landofile/compose/dispositions";

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await mkdtemp(join(tmpdir(), "lando-compose-rejection-"));
  try {
    return await run(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

const failureOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  if (!Exit.isFailure(exit)) return undefined;
  const failure = Cause.failureOption(exit.cause);
  return failure._tag === "Some" ? failure.value : undefined;
};

const loadYamlExit = async (dir: string, content: string) => {
  const source = join(dir, ".lando.yml");
  await writeFile(source, content);
  return { source, exit: await Effect.runPromiseExit(loadLandofileFile(source)) };
};

type ExpectedRejection = {
  readonly keyPath: string;
  readonly remediation: string | undefined;
  readonly service?: string;
  readonly source: string;
};

const expectRejection = (error: unknown, expected: ExpectedRejection): void => {
  expect(error).toBeInstanceOf(ComposeKeyRejectedError);
  if (!(error instanceof ComposeKeyRejectedError)) return;
  expect(error._tag).toBe("ComposeKeyRejectedError");
  expect(error.keyPath).toBe(expected.keyPath);
  expect(error.service).toBe(expected.service);
  expect(error.source).toBe(expected.source);
  if (expected.remediation === undefined) expect(error.remediation).toBeUndefined();
  else expect(error.remediation).toBe(expected.remediation);
};

const yamlService = (...lines: readonly string[]): string =>
  ["name: compose-rejection", "services:", "  web:", "    type: node:22", ...lines, ""].join("\n");

describe("Landofile Compose rejection surface", () => {
  test("rejects extends before generic schema decoding", async () => {
    await withTempDir(async (dir) => {
      // Given
      const { source, exit } = await loadYamlExit(dir, yamlService("    extends:", "      service: base"));

      // When
      const error = failureOf(exit);

      // Then
      expectRejection(error, {
        keyPath: "extends",
        remediation: composeServiceDispositions.extends?.remediation,
        service: "web",
        source,
      });
      expect(error).not.toBeInstanceOf(LandofileValidationError);
      expect(error).not.toBeInstanceOf(LandofileParseError);
    });
  });

  test.each([
    ["container_name", ["    container_name: mydb"], "container_name"],
    ["deploy replica", ["    deploy:", "      replicas: 3"], "deploy.replicas"],
  ] as const)("rejects %s with its precise matrix path", async (_name, lines, keyPath) => {
    await withTempDir(async (dir) => {
      // Given
      const { source, exit } = await loadYamlExit(dir, yamlService(...lines));

      // When
      const error = failureOf(exit);

      // Then
      expectRejection(error, {
        keyPath,
        remediation: composeServiceDispositions[keyPath]?.remediation,
        service: "web",
        source,
      });
    });
  });

  test("preserves deploy.resources", async () => {
    await withTempDir(async (dir) => {
      // Given
      const { exit } = await loadYamlExit(
        dir,
        yamlService("    deploy:", "      resources:", "        limits:", '          cpus: "0.5"'),
      );

      // When / Then
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test.each([
    ["!reset", ["    environment: !reset"]],
    ["!override", ["    ports: !override [80]"]],
  ] as const)("rejects the %s YAML tag without service attribution", async (keyPath, lines) => {
    await withTempDir(async (dir) => {
      // Given
      const { source, exit } = await loadYamlExit(dir, yamlService(...lines));

      // When
      const error = failureOf(exit);

      // Then
      expectRejection(error, {
        keyPath,
        remediation: composeTagDispositions[keyPath].remediation,
        source,
      });
    });
  });

  test("rejects an inline !override before the YAML parser", async () => {
    await withTempDir(async (dir) => {
      // Given
      const { source, exit } = await loadYamlExit(dir, yamlService("    environment: !override {A: 1}"));

      // When
      const error = failureOf(exit);

      // Then
      expectRejection(error, {
        keyPath: "!override",
        remediation: composeTagDispositions["!override"].remediation,
        source,
      });
      expect(error).not.toBeInstanceOf(LandofileParseError);
    });
  });

  test("allows a quoted tag token", async () => {
    await withTempDir(async (dir) => {
      // Given
      const { exit } = await loadYamlExit(dir, yamlService('    command: "!reset"'));

      // When / Then
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });

  test("rejects Compose keys from a TypeScript Landofile", async () => {
    await withTempDir(async (dir) => {
      // Given
      const source = join(dir, ".lando.ts");
      await writeFile(
        source,
        'export default { name: "ts-rejection", services: { web: { type: "node:22", container_name: "x" } } };\n',
      );

      // When
      const error = failureOf(await Effect.runPromiseExit(loadLandofileFile(source)));

      // Then
      expectRejection(error, {
        keyPath: "container_name",
        remediation: composeServiceDispositions.container_name?.remediation,
        service: "web",
        source,
      });
    });
  });

  test("attributes an overlay rejection to the overlay source", async () => {
    await withTempDir(async (dir) => {
      // Given
      const canonicalPath = join(dir, ".lando.yml");
      const overlayPath = join(dir, ".lando.local.yml");
      await writeFile(canonicalPath, yamlService("    image: node:22"));
      await writeFile(overlayPath, yamlService("    container_name: overlay-web"));

      // When
      const error = failureOf(await Effect.runPromiseExit(loadLandofileLayers(dir, canonicalPath)));

      // Then
      expectRejection(error, {
        keyPath: "container_name",
        remediation: composeServiceDispositions.container_name?.remediation,
        service: "web",
        source: overlayPath,
      });
    });
  });

  test("allows ordinary Lando service keys absent from the Compose matrix", async () => {
    await withTempDir(async (dir) => {
      // Given
      const { exit } = await loadYamlExit(
        dir,
        yamlService("    type: php", "    webroot: /app/public", "    appMount: false"),
      );

      // When / Then
      expect(Exit.isSuccess(exit)).toBe(true);
    });
  });
});
