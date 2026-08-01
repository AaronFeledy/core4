import { dirname, resolve } from "node:path";
import { Effect } from "effect";

import { analyzeComposeDispositions } from "../core/src/landofile/compose/rejections.ts";
import { parseLandofile } from "../core/src/landofile/parser.ts";
import { formatGeneratedPaths } from "./_codegen-output.ts";
import { listComposeFixtures } from "./compose-fixtures.ts";
import { writeFixtureFileSafely } from "./fixture-safe-write.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "core/test/fixtures/compose");
const MANIFEST_PATH = resolve(FIXTURES_ROOT, "manifest.json");

export interface ComposeFixtureManifestPaths {
  readonly trustedRoot: string;
  readonly fixturesRoot: string;
  readonly manifestPath: string;
}

export const generateComposeFixtureManifest = async ({
  trustedRoot,
  fixturesRoot,
  manifestPath,
}: ComposeFixtureManifestPaths): Promise<number> => {
  const fixturePaths = await listComposeFixtures({ fixturesRoot });
  const manifest = Object.fromEntries(
    await Promise.all(
      fixturePaths.map(async (relativePath) => {
        const source = resolve(fixturesRoot, relativePath);
        const content = await Bun.file(source).text();
        const parsed = await Effect.runPromise(
          parseLandofile({ file: source, content, cwd: dirname(source) }),
        );
        const rejectedPaths = analyzeComposeDispositions(parsed)
          .filter((match) => match.disposition === "rejected")
          .map((match) => match.matrixPath)
          .sort((left, right) => left.localeCompare(right));
        return [relativePath, rejectedPaths] as const;
      }),
    ),
  );

  await writeFixtureFileSafely({
    trustedRoot,
    fixturesRoot,
    destination: manifestPath,
    data: `${JSON.stringify(manifest, null, 2)}\n`,
  });
  return fixturePaths.length;
};

export const buildComposeFixtureManifest = async (): Promise<void> => {
  const fixtureCount = await generateComposeFixtureManifest({
    trustedRoot: REPO_ROOT,
    fixturesRoot: FIXTURES_ROOT,
    manifestPath: MANIFEST_PATH,
  });
  await formatGeneratedPaths([MANIFEST_PATH]);
  process.stdout.write(`[build-compose-fixture-manifest] wrote ${fixtureCount} fixtures\n`);
};

if (import.meta.main) await buildComposeFixtureManifest();
