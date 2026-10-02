import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LandofileParseError, ManagedFileTransactionError } from "@lando/sdk/errors";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Either } from "effect";
import * as legacyKeys from "../src/legacy-keys.ts";
import { legacyLoadFailure } from "../src/legacy-load-failure.ts";
import { loadLandofileLayers } from "../src/service.ts";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "lando-legacy-load-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
const load = () => loadLandofileLayers(root, join(root, ".lando.yml"));

test.each([
  "recipe: lamp\nconfig:\n  php: '8.3'\n",
  "services:\n  web:\n    api: 3\n",
  "services:\n  web:\n    portforward: true\n",
  "services:\n  web:\n    build_as_root: []\n",
  "tooling:\n  php:\n    options: {}\n",
  "compose: []\n",
  "pluginDirs: []\n",
  "plugins: []\n",
  "excludes: []\n",
])("detects a canonical legacy file when v4 rejects %s", async (content) => {
  // Given
  const sourceFile = join(root, ".lando.yml");
  await writeFile(sourceFile, content);
  // When
  const result = await Effect.runPromise(Effect.either(load()));
  // Then
  expect(Either.isLeft(result) && result.left).toMatchObject({
    _tag: "Lando3LandofileDetected",
    appRoot: root,
    sourceFile,
    remediation: "Run `lando4 app:config:translate --from lando3 --write`.",
  });
});

test.each(["base", "dist", "upstream", "local", "user"])(
  "rejects a legacy %s layer before merging",
  async (layer) => {
    // Given
    const canonicalFile = join(root, ".lando.yml");
    const filename = `.lando.${layer}.yml`;
    await writeFile(canonicalFile, "name: native\nservices:\n  web:\n    type: php:8.3\n");
    await writeFile(join(root, filename), "services:\n  web:\n    overrides: {}\n");
    // When
    const result = await Effect.runPromise(Effect.either(load()));
    // Then
    expect(Either.isLeft(result) && result.left).toMatchObject({
      _tag: "LandofileDialectMixError",
      appRoot: root,
      canonicalFile,
      conflictingLayer: join(root, filename),
      remediation: `Run \`lando4 app:config:translate --from lando3 --file ${filename} --write\`.`,
    });
  },
);

test.each([
  "unknown: true\n",
  "recipe: lamp\nunknown: true\n",
  "services:\n  web:\n    api: 4\nunknown: true\n",
])("preserves the v4 error when content is ambiguous: %s", async (content) => {
  // Given
  await writeFile(join(root, ".lando.yml"), content);
  // When
  const result = await Effect.runPromise(Effect.either(load()));
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe("LandofileValidationError");
});

test("loads v4 catalog types even when a legacy recipe filename exists", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), "name: native\nservices:\n  web:\n    type: php:8.3\n");
  await writeFile(join(root, ".lando.recipe.yml"), "not yaml");
  // When
  const check = spyOn(legacyKeys, "hasLegacyRawKeys");
  try {
    const result = await Effect.runPromise(load());
    // Then
    expect(result.services).toMatchObject({ web: { type: "php:8.3" } });
    expect(check).not.toHaveBeenCalled();
  } finally {
    check.mockRestore();
  }
});

test("detects the recipe filename only after canonical v4 failure", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), "unknown: true\n");
  await writeFile(join(root, ".lando.recipe.yml"), "not yaml");
  // When
  const result = await Effect.runPromise(Effect.either(load()));
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe("Lando3LandofileDetected");
});

test.each([
  ["#".repeat(1024 * 1024), "LandofileParseError"],
  ["# é".repeat(262144), "LandofileParseError"],
  ["#\n".repeat(10000), "LandofileValidationError"],
] as const)("does not inspect signals beyond its byte or line budget (%#)", async (padding, tag) => {
  // Given
  await writeFile(join(root, ".lando.yml"), `${padding}\nrecipe: lamp\nconfig: {}\n`);
  // When
  const result = await Effect.runPromise(Effect.either(load()));
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe(tag);
});

test("blocks pending transactions before inspecting legacy content", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), "recipe: lamp\nconfig: {}\n");
  const failure = new ManagedFileTransactionError({
    reason: "blocked",
    phase: "recover",
    path: root,
    cause: "invariant",
    remediation: "Resolve the journal.",
  });
  let calls = 0;
  // When
  const result = await Effect.runPromise(
    load().pipe(
      Effect.provideService(ManagedFileTransactionGuard, {
        ensureConsistent: () =>
          Effect.suspend(() => {
            calls++;
            return Effect.fail(failure);
          }),
        pending: () => Effect.succeed(null),
      }),
      Effect.either,
    ),
  );
  // Then
  expect(Either.isLeft(result) && result.left).toBe(failure);
  expect(calls).toBe(1);
});

test("detects legacy raw keys after a native syntax error", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), "recipe: lamp\nconfig: {}\nmounts:\n  - {a: 1}\n");
  // When
  const result = await Effect.runPromise(Effect.either(load()));
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe("Lando3LandofileDetected");
});

test("preserves a syntax error without legacy evidence", async () => {
  // Given
  await writeFile(join(root, ".lando.yml"), "mounts:\n  - {a: 1}\n");
  // When
  const result = await Effect.runPromise(Effect.either(load()));
  // Then
  expect(Either.isLeft(result) && result.left._tag).toBe("LandofileParseError");
});

test("preserves the exact original failure object when the hint is ambiguous", async () => {
  // Given
  const sourceFile = join(root, ".lando.yml");
  const original = new LandofileParseError({
    message: "native failure",
    filePath: sourceFile,
    line: 2,
    column: 3,
  });
  // When
  const result = await Effect.runPromise(
    Effect.either(legacyLoadFailure(original, "recipe: lamp\n", { appRoot: root, sourceFile })),
  );
  // Then
  expect(Either.isLeft(result) && result.left).toBe(original);
});
