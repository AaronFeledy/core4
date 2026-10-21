import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { canonicalJson, sha256Hex } from "@lando/sdk/digest";
import { LandofileShape } from "@lando/sdk/schema";
import { Effect, References, Schema } from "effect";
import type { LandofileRuntimeInputs } from "../../src/ports.ts";
import { loadLandofileLayers } from "../../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "../support.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const goldenPath = join(repoRoot, "landofile/test/fixtures/golden-corpus-digests.json");
const Valid = Schema.Struct({ digest: Schema.String });
const Invalid = Schema.Struct({
  invalid: Schema.Struct({ status: Schema.Literal("invalid"), tag: Schema.String }),
});
const Outcome = Schema.Union([Valid, Invalid]);
const Golden = Schema.Struct({
  fixtures: Schema.Array(
    Schema.Union([
      Schema.Struct({ fixture: Schema.String, ...Valid.fields }),
      Schema.Struct({ fixture: Schema.String, ...Invalid.fields }),
    ]),
  ),
  intended: Schema.Record(
    Schema.String,
    Schema.Struct({
      before: Outcome,
      after: Outcome,
      reason: Schema.String.check(Schema.isMinLength(1)),
    }),
  ),
});

test("every guide app retains its encoded Landofile digest or tagged load failure", async () => {
  // Given
  const paths = [
    ...new Bun.Glob("docs/guides/**/fixtures/**/.lando.{yml,ts}").scanSync({
      cwd: repoRoot,
      dot: true,
    }),
  ].sort();
  const apps = [...new Map(paths.map((path) => [dirname(path), path])).entries()];
  const update = process.env.UPDATE_GOLDEN === "1";
  const golden =
    update && !(await Bun.file(goldenPath).exists())
      ? { fixtures: [], intended: {} }
      : Schema.decodeUnknownSync(Golden)(await Bun.file(goldenPath).json());
  const root = await mkdtemp(join(tmpdir(), "lando-golden-corpus-"));
  try {
    const inputs: LandofileRuntimeInputs = {
      ports: makeTestLandofilePorts(join(root, "cache"), join(root, "includes")),
      stateStore: makeTestLandofileStateStore(),
      templates: { modules: [], context: { env: {}, scope: "app", bootstrapLevel: "plugins" } },
    };
    // When
    const fixtures: Array<(typeof Golden.Type)["fixtures"][number]> = [];
    for (const [fixture, path] of apps) {
      const appRoot = join(repoRoot, fixture);
      const result = await Effect.runPromise(
        loadLandofileLayers(appRoot, join(repoRoot, path), inputs).pipe(
          Effect.map((landofile) => ({
            digest: sha256Hex(canonicalJson(Schema.encodeSync(LandofileShape)(landofile))),
          })),
          Effect.catch((error) =>
            Effect.succeed({ invalid: { status: "invalid" as const, tag: error._tag } }),
          ),
          Effect.provideService(References.TracerEnabled, false),
        ),
      );
      fixtures.push({ fixture, ...result });
    }
    const snapshot = fixtures.map(({ fixture, ...result }) => ({
      fixture,
      ...(golden.intended[fixture]?.before ?? result),
    }));
    if (update)
      await Bun.write(
        goldenPath,
        `${JSON.stringify({ fixtures: snapshot, intended: golden.intended }, null, 2)}\n`,
      );
    // Then
    const expected = update ? snapshot : golden.fixtures;
    expect(fixtures.length).toBeGreaterThan(0);
    expect(fixtures.length).toBe(expected.length);
    expect(fixtures.map(({ fixture }) => fixture)).toEqual(expected.map(({ fixture }) => fixture));
    const actual = new Map(fixtures.map(({ fixture, ...result }) => [fixture, result]));
    for (const { fixture, ...result } of expected) {
      const intended = golden.intended[fixture];
      if (intended !== undefined) expect(result, fixture).toEqual(intended.before);
      expect(actual.get(fixture), fixture).toEqual(intended?.after ?? result);
    }
    for (const fixture of Object.keys(golden.intended)) expect(actual.has(fixture), fixture).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30_000);
