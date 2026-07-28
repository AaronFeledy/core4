import { describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Layer } from "effect";

import { CapabilityError, ComposeKeyRejectedError } from "@lando/core/errors";
import {
  ComposeServiceFieldKey,
  ComposeServiceKnobKey,
  type LandofileShape,
  type ProviderCapabilities,
  ServiceName,
} from "@lando/core/schema";
import { AppPlanner } from "@lando/core/services";
import { TestRuntimeProvider } from "@lando/sdk/test";

import { rememberLandofileAppRoot } from "../../src/landofile/app-root-provenance.ts";
import { composeServiceDispositions } from "../../src/landofile/compose/dispositions.ts";
import {
  type ComposeDispositionMatch,
  analyzeComposeDispositions,
} from "../../src/landofile/compose/rejections.ts";
import { parseLandofile } from "../../src/landofile/parser.ts";
import { loadLandofileFile } from "../../src/landofile/service.ts";
import { makePluginRegistryLive } from "../../src/plugins/registry.ts";
import { FileSystemLive } from "../../src/services/file-system.ts";
import { AppPlannerLive } from "../../src/services/planner.ts";
import { COMPOSE_FIXTURE_ASSERTIONS } from "./compose-fixture-assertion-metadata.ts";
import { assertFixtureServiceOutcomes, materializeFixtureEnvFiles } from "./compose-fixture-outcomes.ts";
import { REQUIRED_RAW_FIXTURE_PATHS, assertRawFixtureOutcome } from "./compose-fixture-raw-expectations.ts";

type ComposeFixtureModule = {
  readonly listComposeFixtures: (options: {
    readonly fixturesRoot: string;
  }) => Promise<ReadonlyArray<string>>;
};

type FixtureCase = {
  readonly relativePath: string;
  readonly id: string;
  readonly content: string;
  readonly matches: ReadonlyArray<ComposeDispositionMatch>;
};

class ComposeFixtureInvariantError extends Error {
  override readonly name = "ComposeFixtureInvariantError";
}

const isComposeFixtureModule = (value: unknown): value is ComposeFixtureModule =>
  typeof value === "object" &&
  value !== null &&
  "listComposeFixtures" in value &&
  typeof value.listComposeFixtures === "function";

const repoRoot = resolve(import.meta.dirname, "../../..");
const fixturesRoot = resolve(repoRoot, "core/test/fixtures/compose");
const manifestPath = resolve(fixturesRoot, "manifest.json");
const importedFixtureModule: unknown = await import(
  pathToFileURL(resolve(repoRoot, "scripts/compose-fixtures.ts")).href
);
if (!isComposeFixtureModule(importedFixtureModule)) throw new ComposeFixtureInvariantError();
const { listComposeFixtures } = importedFixtureModule;

const fixtureCases: ReadonlyArray<FixtureCase> = await Promise.all(
  (await listComposeFixtures({ fixturesRoot })).map(async (relativePath) => {
    const source = resolve(fixturesRoot, relativePath);
    const content = await Bun.file(source).text();
    const parsed = await Effect.runPromise(parseLandofile({ file: source, content, cwd: dirname(source) }));
    return {
      relativePath,
      id: relativePath.replace(/\.compose\.yaml$/u, "").replace(/[^a-z0-9-]+/gu, "-"),
      content,
      matches: analyzeComposeDispositions(parsed),
    };
  }),
);

const registryLayer = makePluginRegistryLive({ app: false, user: false });
const plannerLayer = AppPlannerLive.pipe(Layer.provide(FileSystemLive));
const nativeCapabilities: ProviderCapabilities = {
  ...TestRuntimeProvider.capabilities,
  composeSpec: "native",
  composeKnobs: { supported: [...ComposeServiceKnobKey.literals] },
  composeServiceFields: { supported: [...ComposeServiceFieldKey.literals] },
};
const restrictedCapabilities: ProviderCapabilities = {
  ...nativeCapabilities,
  composeServiceFields: { supported: ["x-*"] },
};

const withTempDir = async <T>(run: (dir: string) => Promise<T>): Promise<T> => {
  const dir = await realpath(await mkdtemp(join(tmpdir(), "lando-compose-conformance-")));
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

const planLandofile = (landofile: LandofileShape, capabilities: ProviderCapabilities = nativeCapabilities) =>
  Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
    Effect.provide(plannerLayer),
    Effect.provide(registryLayer),
    Effect.runPromise,
  );

const planLandofileExit = (landofile: LandofileShape, capabilities: ProviderCapabilities) =>
  Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, capabilities)).pipe(
    Effect.provide(plannerLayer),
    Effect.provide(registryLayer),
    Effect.runPromiseExit,
  );

const loadPlannableFixture = async (dir: string, fixture: FixtureCase): Promise<LandofileShape> => {
  const loaded = await loadYamlExit(dir, `name: ${fixture.id}\n${fixture.content}`);
  if (!Exit.isSuccess(loaded.exit)) throw new ComposeFixtureInvariantError();
  return rememberLandofileAppRoot<LandofileShape>(
    {
      ...loaded.exit.value,
      services: Object.fromEntries(
        Object.entries(loaded.exit.value.services ?? {}).map(([name, service]) => [
          name,
          { ...service, type: "compose" },
        ]),
      ),
    },
    dir,
  );
};

const capabilityGatedRoots = new Set<ComposeServiceFieldKey>(["networks", "configs", "secrets", "profiles"]);

const serviceFieldFamily = (matrixPath: string): ComposeServiceFieldKey | undefined => {
  const root = matrixPath.split(".")[0];
  return ComposeServiceFieldKey.literals.find((candidate) => candidate === root);
};

const capabilityGateCases = fixtureCases.flatMap((fixture) => {
  const servicesByFamily = new Map<ComposeServiceFieldKey, string>();
  for (const match of fixture.matches) {
    const family = serviceFieldFamily(match.matrixPath);
    if (
      family !== undefined &&
      capabilityGatedRoots.has(family) &&
      match.service !== undefined &&
      !servicesByFamily.has(family)
    ) {
      servicesByFamily.set(family, match.service);
    }
  }
  return [...servicesByFamily].map(([family, service]) => ({ fixture, family, service }));
});

const supportedPaths = (fixtures: ReadonlyArray<FixtureCase>): ReadonlySet<string> =>
  new Set(
    fixtures.flatMap(({ matches }) =>
      matches.flatMap((match) =>
        match.service !== undefined &&
        (match.disposition === "normalized" || match.disposition === "preserved")
          ? [match.matrixPath]
          : [],
      ),
    ),
  );

describe("Compose conformance fixtures", () => {
  for (const fixture of fixtureCases) {
    test(`executes ${fixture.relativePath} from the disposition matrix`, async () => {
      await withTempDir(async (dir) => {
        // Given
        const loaded = await loadYamlExit(dir, `name: ${fixture.id}\n${fixture.content}`);
        const firstRejection = fixture.matches.find((match) => match.disposition === "rejected");
        let executedAssertionCount = 0;

        if (firstRejection !== undefined) {
          // When
          const error = failureOf(loaded.exit);

          // Then
          expect(error).toBeInstanceOf(ComposeKeyRejectedError);
          if (!(error instanceof ComposeKeyRejectedError)) return;
          expect(error.keyPath).toBe(firstRejection.matrixPath);
          if (firstRejection.remediation === undefined) throw new ComposeFixtureInvariantError();
          expect(error.remediation).toBe(firstRejection.remediation);
          executedAssertionCount += 2;
          expect(executedAssertionCount).toBeGreaterThan(0);
          return;
        }

        expect(Exit.isSuccess(loaded.exit)).toBe(true);
        if (!Exit.isSuccess(loaded.exit)) return;
        await materializeFixtureEnvFiles(dir, loaded.exit.value);
        const composeLandofile = rememberLandofileAppRoot<LandofileShape>(
          {
            ...loaded.exit.value,
            services: Object.fromEntries(
              Object.entries(loaded.exit.value.services ?? {}).map(([name, service]) => [
                name,
                { ...service, type: "compose" },
              ]),
            ),
          },
          dir,
        );

        // When
        const plan = await planLandofile(composeLandofile);

        // Then
        executedAssertionCount = assertFixtureServiceOutcomes(fixture.matches, {
          appRoot: dir,
          landofile: loaded.exit.value,
          plan,
        });
        assertRawFixtureOutcome(fixture.relativePath, {
          appRoot: dir,
          landofile: loaded.exit.value,
          plan,
        });
        const expectedAssertionCount = fixture.matches.filter(
          (match) => match.service !== undefined && match.disposition !== "rejected",
        ).length;
        expect(executedAssertionCount).toBe(expectedAssertionCount);
      });
    });
  }

  test("matches the committed rejection manifest exactly", async () => {
    // Runtime classification is authoritative; the committed manifest is only its drift/provenance record.
    // Given
    const committedManifest: unknown = JSON.parse(await Bun.file(manifestPath).text());

    // When
    const runtimeManifest = Object.fromEntries(
      fixtureCases.map(({ relativePath, matches }) => [
        relativePath,
        matches
          .filter((match) => match.disposition === "rejected")
          .map((match) => match.matrixPath)
          .sort(),
      ]),
    );

    // Then
    expect(committedManifest).toEqual(runtimeManifest);
  });

  test("keeps every supported path visible in a non-rejected fixture", () => {
    // Given
    const supported = supportedPaths(fixtureCases);

    // When
    const asserted = supportedPaths(
      fixtureCases.filter(({ matches }) => !matches.some((match) => match.disposition === "rejected")),
    );
    const hidden = [...supported].filter((path) => !asserted.has(path)).sort();

    // Then
    expect(supported.size).toBeGreaterThan(0);
    expect(hidden).toEqual([]);
  });

  test("keeps an authored-value expectation for every required curated fixture", () => {
    // Given
    const committedFixtures = new Set(fixtureCases.map(({ relativePath }) => relativePath));

    // When
    const missing = REQUIRED_RAW_FIXTURE_PATHS.filter((path) => !committedFixtures.has(path));

    // Then
    expect(missing).toEqual([]);
  });

  test("keeps test assertion metadata exhaustive for normalized service roots", () => {
    // Given
    const normalizedRoots = Object.entries(composeServiceDispositions)
      .filter(([path, entry]) => !path.includes(".") && entry.disposition === "normalized")
      .map(([path]) => path)
      .sort();

    // When
    const metadataRoots = Object.keys(COMPOSE_FIXTURE_ASSERTIONS).sort();

    // Then
    expect(metadataRoots).toEqual(normalizedRoots);
  });
});

describe("Compose service-field capability gate", () => {
  test("exercises at least one restricted service-field fixture", () => {
    // Given
    const cases = capabilityGateCases;

    // When
    const caseCount = cases.length;

    // Then
    expect(caseCount).toBeGreaterThan(0);
  });

  for (const { fixture, family, service } of capabilityGateCases) {
    test(`rejects ${fixture.relativePath} ${family} before provider execution`, async () => {
      await withTempDir(async (dir) => {
        // Given
        const landofile = await loadPlannableFixture(dir, fixture);

        // When
        const error = failureOf(await planLandofileExit(landofile, restrictedCapabilities));

        // Then
        expect(error).toBeInstanceOf(CapabilityError);
        if (!(error instanceof CapabilityError)) return;
        expect(error.service).toBe(service);
        expect(error.key).toBe(family);
        expect(error.capability).toBe("composeSpec");
        expect(error.providerId).toBe("lando");
        expect(error.remediation).toBeDefined();
      });
    });

    test(`plans ${fixture.relativePath} ${family} with native capabilities`, async () => {
      await withTempDir(async (dir) => {
        // Given
        const landofile = await loadPlannableFixture(dir, fixture);

        // When
        const plan = await planLandofile(landofile, nativeCapabilities);

        // Then
        expect(plan.services[ServiceName.make(service)]).toBeDefined();
      });
    });
  }

  test("exercises every Compose service-field family in non-rejected fixtures", () => {
    // Given
    const nonRejectedFixtures = fixtureCases.filter(
      ({ matches }) => !matches.some((match) => match.disposition === "rejected"),
    );

    // When
    const observedFamilies = new Set(
      nonRejectedFixtures.flatMap(({ matches }) =>
        matches.flatMap((match) => {
          if (match.service === undefined) return [];
          const family = serviceFieldFamily(match.matrixPath);
          return family === undefined ? [] : [family];
        }),
      ),
    );

    // Then
    expect(observedFamilies).toEqual(new Set(ComposeServiceFieldKey.literals));
  });
});
