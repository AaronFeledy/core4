import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLandofile } from "@lando/landofile/parser";
import { ManagedFileTransactionGuard } from "@lando/sdk/services";
import { Effect, Schema } from "effect";
import { AppConfigMigrateResultSchema, appConfigMigrate } from "../../src/cli/commands/app-config-migrate.ts";
import { makeMigrationFixture, managedLandofile } from "./fixtures/recipe-migrations.ts";

const roots: string[] = [];
const originalDataRoot = process.env.LANDO_USER_DATA_ROOT;
afterEach(async () => {
  if (originalDataRoot === undefined) Reflect.deleteProperty(process.env, "LANDO_USER_DATA_ROOT");
  else process.env.LANDO_USER_DATA_ROOT = originalDataRoot;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const setup = async () => {
  const cwd = await mkdtemp(join(tmpdir(), "lando-migrate-command-"));
  roots.push(cwd);
  process.env.LANDO_USER_DATA_ROOT = join(cwd, "state");
  const text = managedLandofile();
  await Bun.write(join(cwd, ".lando.yml"), text);
  const fixture = makeMigrationFixture();
  const recipes = new Map([
    [fixture.target.identity.recipeId, { snapshot: fixture.target, migrations: fixture.migrations }],
  ]);
  return { cwd, recipes, text };
};

test("previews all hunks without changing bytes when dry-run is non-interactive", async () => {
  // Given
  const input = await setup();
  // When
  const result = await Effect.runPromise(appConfigMigrate({ ...input, dryRun: true, nonInteractive: true }));
  // Then
  expect(Schema.is(AppConfigMigrateResultSchema)(result)).toBe(true);
  expect(result.edges.flatMap((edge) => edge.hunks)).toHaveLength(6);
  expect(await Bun.file(join(input.cwd, ".lando.yml")).text()).toBe(input.text);
});

test("fails closed when selectable hunks lack non-interactive approval", async () => {
  // Given
  const input = await setup();
  // When
  const result = await Effect.runPromise(
    appConfigMigrate({ ...input, nonInteractive: true }).pipe(Effect.either),
  );
  // Then
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "AppConfigMigrateError", reason: "confirmation-required" },
  });
});

test("inspects pending recovery without locking when dry-run input is invalid", async () => {
  // Given
  const input = await setup();
  await Bun.write(join(input.cwd, ".lando.yml"), "invalid: [");
  let ensured = false;
  const report = {
    id: "journal-1",
    state: "blocked" as const,
    action: "manual-resolution" as const,
    targets: [".lando.yml"],
  };
  // When
  const result = await Effect.runPromise(
    appConfigMigrate({ ...input, dryRun: true }).pipe(
      Effect.provideService(ManagedFileTransactionGuard, {
        ensureConsistent: () =>
          Effect.sync(() => {
            ensured = true;
          }),
        pending: () => Effect.succeed(report),
      }),
      Effect.either,
    ),
  );
  // Then
  expect(ensured).toBe(false);
  expect(result).toMatchObject({
    _tag: "Left",
    left: { _tag: "ManagedFileTransactionError", reason: "blocked", phase: "inspect" },
  });
});

test("does not call ensureConsistent on a clean dry-run", async () => {
  // Given
  const input = await setup();
  let ensured = false;
  let pendingCalls = 0;
  // When
  const result = await Effect.runPromise(
    appConfigMigrate({ ...input, dryRun: true, nonInteractive: true }).pipe(
      Effect.provideService(ManagedFileTransactionGuard, {
        ensureConsistent: () =>
          Effect.sync(() => {
            ensured = true;
          }),
        pending: () =>
          Effect.sync(() => {
            pendingCalls += 1;
            return null;
          }),
      }),
    ),
  );
  // Then
  expect(ensured).toBe(false);
  expect(pendingCalls).toBe(1);
  expect(result.mode).toBe("dry-run");
});

test("writes the final producer through the coordinator when all hunks are approved", async () => {
  // Given
  const input = await setup();
  // When
  const result = await Effect.runPromise(appConfigMigrate({ ...input, yes: true }));
  // Then
  expect(result.status).toBe("committed");
  const written = await Effect.runPromise(
    parseLandofile({
      file: join(input.cwd, ".lando.yml"),
      content: await Bun.file(join(input.cwd, ".lando.yml")).text(),
      cwd: input.cwd,
    }),
  );
  expect(written).toMatchObject({ recipe: { producer: makeMigrationFixture().target.identity } });
});

test("preserves bytes when an approved migration is repeated", async () => {
  // Given
  const input = await setup();
  await Effect.runPromise(appConfigMigrate({ ...input, yes: true }));
  const before = await Bun.file(join(input.cwd, ".lando.yml")).text();
  // When
  const result = await Effect.runPromise(appConfigMigrate(input));
  // Then
  expect(result).toMatchObject({ status: "no-op", noMutation: "already-current" });
  expect(await Bun.file(join(input.cwd, ".lando.yml")).text()).toBe(before);
});

test("maps engine blocking edges to blocked and skipped when the first edge cannot land", async () => {
  // Given
  const input = await setup();
  const fixture = makeMigrationFixture();
  const recipes = new Map([
    [fixture.target.identity.recipeId, { snapshot: fixture.target, migrations: fixture.nonCanonical }],
  ]);
  // When
  const result = await Effect.runPromise(appConfigMigrate({ ...input, recipes, dryRun: true }));
  // Then
  expect(result.edges.map((edge) => edge.status)).toEqual(["blocked", "skipped"]);
  expect(result.status).toBe("blocked");
});

test("fails closed when a valid recorded recipe is absent from the injected source", async () => {
  // Given
  const input = await setup();
  // When
  const result = await Effect.runPromise(
    appConfigMigrate({ ...input, recipes: new Map(), dryRun: true }).pipe(Effect.either),
  );
  // Then
  expect(result).toMatchObject({ _tag: "Left", left: { reason: "unknown-recipe" } });
});
