import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Cause, Effect, Exit, Layer } from "effect";

import { ComposeKeyRejectedError } from "@lando/core/errors";
import {
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

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isComposeFixtureModule = (value: unknown): value is ComposeFixtureModule =>
  isRecord(value) && "listComposeFixtures" in value && typeof value.listComposeFixtures === "function";

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

const materializeEnvFiles = async (dir: string, landofile: LandofileShape): Promise<void> => {
  for (const service of Object.values(landofile.services ?? {})) {
    for (const envFile of service.envFile ?? []) {
      const destination = join(dir, envFile);
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, "");
    }
  }
};

const planLandofile = (landofile: LandofileShape) =>
  Effect.flatMap(AppPlanner, (planner) => planner.plan(landofile, nativeCapabilities)).pipe(
    Effect.provide(plannerLayer),
    Effect.provide(registryLayer),
    Effect.runPromise,
  );

const supportedRootPaths = (fixtures: ReadonlyArray<FixtureCase>): ReadonlySet<string> =>
  new Set(
    fixtures.flatMap(({ matches }) =>
      matches.flatMap((match) =>
        match.service !== undefined &&
        !match.matrixPath.includes(".") &&
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
          expect(error.remediation).toBe(firstRejection.remediation);
          executedAssertionCount += 2;
          expect(executedAssertionCount).toBeGreaterThan(0);
          return;
        }

        expect(Exit.isSuccess(loaded.exit)).toBe(true);
        if (!Exit.isSuccess(loaded.exit)) return;
        await materializeEnvFiles(dir, loaded.exit.value);
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
        for (const match of fixture.matches) {
          if (match.service === undefined) continue;
          switch (match.disposition) {
            case "normalized": {
              if (match.matrixPath.includes(".")) continue;
              const planTarget = composeServiceDispositions[match.matrixPath]?.planTarget;
              expect(planTarget).toBeDefined();
              if (planTarget === undefined) continue;
              const decodedService: unknown = loaded.exit.value.services?.[match.service];
              expect(isRecord(decodedService) && decodedService[planTarget] !== undefined).toBe(true);
              executedAssertionCount += 1;
              break;
            }
            case "preserved": {
              const documentPrefix = `services.${match.service}.`;
              const rootDocumentKey = match.documentPath.startsWith(documentPrefix)
                ? match.documentPath.slice(documentPrefix.length)
                : undefined;
              const composeKey = !match.matrixPath.includes(".")
                ? rootDocumentKey
                : match.matrixPath === "deploy.resources"
                  ? "deploy"
                  : match.matrixPath === "volumes.tmpfs"
                    ? "tmpfs"
                    : undefined;
              if (composeKey === undefined) continue;
              const compose = plan.services[ServiceName.make(match.service)]?.extensions.compose;
              expect(isRecord(compose) && compose[composeKey] !== undefined).toBe(true);
              executedAssertionCount += 1;
              break;
            }
            case "rejected":
              break;
            default: {
              const unhandled: never = match.disposition;
              throw new ComposeFixtureInvariantError(`Unhandled disposition: ${unhandled}`);
            }
          }
        }
        expect(executedAssertionCount).toBeGreaterThan(0);
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
    expect(runtimeManifest).toEqual(committedManifest);
  });

  test("keeps every supported root visible in a non-rejected fixture", () => {
    // Given
    const supportedRoots = supportedRootPaths(fixtureCases);

    // When
    const assertedRoots = supportedRootPaths(
      fixtureCases.filter(({ matches }) => !matches.some((match) => match.disposition === "rejected")),
    );
    const hiddenRoots = [...supportedRoots].filter((path) => !assertedRoots.has(path)).sort();

    // Then
    expect(supportedRoots.size).toBeGreaterThan(0);
    expect(hiddenRoots).toEqual([]);
  });
});
