import { dirname, resolve } from "node:path";
import { Effect } from "effect";

import { analyzeComposeDispositions } from "../core/src/landofile/compose/rejections.ts";
import { parseLandofile } from "../core/src/landofile/parser.ts";
import { listComposeFixtures } from "./compose-fixtures.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const FIXTURES_ROOT = resolve(REPO_ROOT, "core/test/fixtures/compose");
const MANIFEST_PATH = resolve(FIXTURES_ROOT, "manifest.json");

class ComposeFixtureManifestFormatError extends Error {
  override readonly name = "ComposeFixtureManifestFormatError";

  constructor(readonly exitCode: number) {
    super(`Biome failed to format the Compose fixture manifest with exit code ${exitCode}.`);
  }
}

export const buildComposeFixtureManifest = async (): Promise<void> => {
  const fixturePaths = await listComposeFixtures({ fixturesRoot: FIXTURES_ROOT });
  const manifest = Object.fromEntries(
    await Promise.all(
      fixturePaths.map(async (relativePath) => {
        const source = resolve(FIXTURES_ROOT, relativePath);
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

  await Bun.write(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
  const formatter = Bun.spawn(["bun", "run", "biome", "check", "--write", MANIFEST_PATH], {
    cwd: REPO_ROOT,
    stdout: "ignore",
    stderr: "inherit",
  });
  const formatterExitCode = await formatter.exited;
  if (formatterExitCode !== 0) throw new ComposeFixtureManifestFormatError(formatterExitCode);
  process.stdout.write(`[build-compose-fixture-manifest] wrote ${fixturePaths.length} fixtures\n`);
};

if (import.meta.main) await buildComposeFixtureManifest();
