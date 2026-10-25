import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { evaluateTemplateEither, parseExpressionEither } from "@lando/sdk/expressions";
import { type ValueOrigins, isLandofileOverride, isLandofileReset } from "@lando/sdk/landofile";
import { Effect, Predicate, Result } from "effect";
import { LANDOFILE_LAYER_POSITIONS } from "../src/layers.ts";
import { getOrigins } from "../src/pipeline/origins.ts";
import type { AuthoredOrigin } from "../src/pipeline/prepare.ts";
import { getSourceDocuments } from "../src/pipeline/source-table.ts";
import { composeLandofileRootLayers } from "../src/service.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "./support.ts";

type Path = readonly (string | number)[];
const repoRoot = resolve(import.meta.dirname, "../..");
const scratch = await mkdtemp(join(tmpdir(), "lando-provenance-invariant-"));
afterAll(() => rm(scratch, { recursive: true, force: true }));
const inputs = {
  ports: makeTestLandofilePorts(join(scratch, "cache"), join(scratch, "includes")),
  stateStore: makeTestLandofileStateStore(),
  templates: { modules: [] },
};

function unwrap(value: unknown): unknown {
  if (isLandofileOverride(value)) return unwrap(value.value);
  if (isLandofileReset(value)) return undefined;
  return value;
}

function authoredValueAt(document: unknown, path: Path): unknown {
  let value = document;
  for (const key of path) {
    value = unwrap(value);
    if (!Predicate.isObjectOrArray(value)) return undefined;
    value = Reflect.get(value, key);
  }
  return unwrap(value);
}

function exactOriginAt(
  origins: ValueOrigins<AuthoredOrigin> | undefined,
  path: Path,
): ValueOrigins<AuthoredOrigin> {
  let cursor = origins;
  for (const key of path) cursor = cursor?.children.get(key);
  expect(cursor, `Missing exact origin at ${JSON.stringify(path)}`).toBeDefined();
  if (cursor === undefined) throw new Error(`Missing origin at ${JSON.stringify(path)}`);
  return cursor;
}

function* scalarLeaves(value: unknown, path: Path = []): Generator<{ path: Path; value: unknown }> {
  const unwrapped = unwrap(value);
  if (Predicate.isObjectOrArray(unwrapped)) {
    for (const [key, child] of Object.entries(unwrapped)) {
      const segment = Array.isArray(unwrapped) ? Number(key) : key;
      yield* scalarLeaves(child, [...path, segment]);
    }
    return;
  }
  yield { path, value: unwrapped };
}

function assertProvenance(document: object): number {
  const documents = getSourceDocuments(document);
  const origins = getOrigins(document);
  let checked = 0;
  for (const { path, value } of scalarLeaves(document)) {
    const { source } = exactOriginAt(origins, path);
    const retained = documents.find(({ file, layer }) => file === source.file && layer === source.layer);
    expect(
      retained,
      `Unretained source for ${JSON.stringify(path)}: ${JSON.stringify(source)}`,
    ).toBeDefined();
    if (retained === undefined) throw new Error(`Unretained source ${source.file}`);
    const authored = authoredValueAt(retained.document, source.path);
    checked++;
    if (
      typeof authored === "string" &&
      /^\s*\{\{[\s\S]*\b(?:load|import)\s*\([\s\S]*\}\}\s*$/.test(authored)
    ) {
      // load()/import() run before prepareOverlay. Produced descendants and escaped
      // text have no authored counterpart: their cursor must name the expression itself.
      continue;
    }
    if (
      typeof authored === "string" &&
      typeof value === "string" &&
      path.length === 3 &&
      ((path[0] === "includes" &&
        path[2] === "source" &&
        authoredValueAt(retained.document, [...source.path.slice(0, -1), "kind"]) === "tooling") ||
        (path[0] === "toolingIncludes" && path[2] === "file"))
    ) {
      // resolveToolingIncludeSourceRoots may absolutize a tooling file relative
      // to its declaring document, not the root app or the winning outer layer.
      expect(resolve(dirname(source.file), value), JSON.stringify(path)).toBe(
        resolve(dirname(source.file), authored),
      );
    } else {
      const template =
        typeof authored === "string"
          ? parseExpressionEither(authored, { filePath: source.file, bareShellParameters: "preserve" })
          : undefined;
      const literal =
        template !== undefined &&
        Result.isSuccess(template) &&
        template.success.segments.every(
          (segment) => segment.kind === "LiteralSegment" || segment.kind === "CommentSegment",
        )
          ? Result.getOrThrow(evaluateTemplateEither(template.success, {}))
          : authored;
      expect(value, `${JSON.stringify(path)} from ${JSON.stringify(source)}`).toEqual(literal);
    }
  }
  return checked;
}

// Match the guide golden-corpus enumeration, including TS forms and roots whose
// only authored layer is base/local; compose each app directory once.
const basenames = `{${LANDOFILE_LAYER_POSITIONS.map(({ basename }) => basename).join(",")}}`;
const fixtureFiles = ["docs/guides/**/fixtures/**", "recipes/*/.scaffold/**"]
  .flatMap((directory) => [
    ...new Bun.Glob(`${directory}/${basenames}.{yml,ts}`).scanSync({ cwd: repoRoot, dot: true }),
  ])
  .sort();
const fixtureRoots = [...new Set(fixtureFiles.map(dirname))];
const outcomes: { fixture: string; leaves?: number; reason?: string }[] = [];
const acquisitionExclusions = new Map([
  ["docs/guides/compose-service-block/fixtures/compose-service-block-rejected", "ComposeKeyRejectedError"],
  ["docs/guides/includes-and-lockfile/fixtures/user-profile-demo", "LandofileIncludeError"],
  ["docs/guides/migrating-recipes/fixtures/programmatic-app", "LandofileFormConflictError"],
  ["docs/guides/timezone/fixtures/timezone-rejected-interpolation", "LandofileValidationError"],
  ["docs/guides/expressions/fixtures/expressions-unescaped-shell", "LandofileValidationError"],
  ["docs/guides/your-landofile/fixtures/flow-mapping-rejected", "LandofileParseError"],
]);

describe("composed Landofile provenance invariant", () => {
  for (const fixture of fixtureRoots) {
    test(fixture, async () => {
      // Given: a real guide or recipe scaffold app and isolated offline test ports.
      const root = join(repoRoot, fixture);
      // When: compose through the fold, without runtime finalization/defaults.
      const result = await Effect.runPromise(composeLandofileRootLayers(root, inputs).pipe(Effect.result));
      // Then: every composed scalar has exact, retained, value-faithful provenance.
      if (Result.isFailure(result)) {
        expect(acquisitionExclusions.get(fixture), fixture).toBe(result.failure._tag);
        outcomes.push({ fixture, reason: `${result.failure._tag}: ${result.failure.message}` });
        return;
      }
      outcomes.push({ fixture, leaves: assertProvenance(result.success.merged) });
    });
  }

  test("checks a non-vacuous fixture corpus and reports acquisition exclusions", () => {
    // Given: all enumerated fixture compositions have completed.
    const checked = outcomes.filter(({ leaves }) => leaves !== undefined);
    const excluded = outcomes.filter(({ reason }) => reason !== undefined);
    // When: summarize the actual coverage, including offline composition failures.
    console.info(`Provenance fixtures: ${checked.length} checked, ${excluded.length} cannot compose`);
    for (const { fixture, reason } of excluded) console.info(`${fixture}: ${reason}`);
    // Then: acquisition failures cannot turn this into an empty green test.
    expect(outcomes).toHaveLength(fixtureRoots.length);
    expect(checked.length).toBeGreaterThanOrEqual(210);
    expect(checked.every(({ leaves }) => leaves !== undefined && leaves > 0)).toBe(true);
    expect(excluded.map(({ fixture }) => fixture).sort()).toEqual([...acquisitionExclusions.keys()].sort());
  });

  test("tooling includes across fragment, canonical and local layers retain every scalar origin (#1625)", async () => {
    // Given: tooling membership is rebuilt after fragment filtering and layer composition.
    const root = join(scratch, "layered-tooling");
    await Bun.write(
      join(root, ".lando.yml"),
      "name: provenance\nincludes:\n  - ./fragment.yml\n  - source: ./canonical.yml\n    kind: tooling\n    namespace: canonical\n",
    );
    await Bun.write(
      join(root, "fragment.yml"),
      "includes:\n  - source: ./fragment-tools.yml\n    kind: tooling\n    namespace: fragment\n",
    );
    await Bun.write(
      join(root, ".lando.local.yml"),
      "includes:\n  - source: ./local.yml\n    kind: tooling\n    namespace: local\ntoolingIncludes:\n  shorthand:\n    file: ./shorthand.yml\n",
    );
    // When: inspect the post-fold document, before tooling fragments or defaults materialize.
    const { merged } = await Effect.runPromise(composeLandofileRootLayers(root, inputs));
    // Then: no composed entry may borrow the local includes ancestor's provenance.
    expect(merged.includes).toHaveLength(3);
    expect(assertProvenance(merged)).toBeGreaterThanOrEqual(11);
  });

  test("load/import descendants point at expression sites despite escaped produced text", async () => {
    // Given: both file helpers expand scalars into objects before overlay preparation.
    const root = join(scratch, "file-helpers");
    await Bun.write(join(root, "payload.json"), JSON.stringify({ nested: ["{{ app.name }} ${VALUE}", 17] }));
    await Bun.write(
      join(root, ".lando.yml"),
      `name: helpers\nx-loaded: "{{ load('./payload.json') }}"\nx-imported: "{{ import('./payload.json').value }}"\n`,
    );
    // When: compose, leaving recipe/environment expressions unmaterialized.
    const { merged, runtime } = await Effect.runPromise(composeLandofileRootLayers(root, inputs));
    // Then: produced text stays inert data with no newly compiled expression sites.
    expect(merged["x-loaded"]).toEqual({ nested: ["{{ app.name }} ${VALUE}", 17] });
    expect(merged["x-imported"]).toEqual({ nested: ["{{ app.name }} ${VALUE}", 17] });
    expect(runtime.pendingSites).toEqual([]);
    expect(assertProvenance(merged)).toBe(5);
    for (const key of ["x-loaded", "x-imported"]) {
      expect(exactOriginAt(getOrigins(merged), [key, "nested", 0]).source.path).toEqual([key]);
    }
  });

  test("aliases, override ancestors and relocated keyed-list entries need no provenance exemptions", async () => {
    // Given: canonical routes move an inherited route's index; local aliases sit inside override wrappers.
    const root = join(scratch, "authored-cursors");
    await Bun.write(
      join(root, ".lando.base.yml"),
      "services:\n  web:\n    routes:\n      - hostname: inherited.test\n        port: 81\n",
    );
    await Bun.write(
      join(root, ".lando.yml"),
      "name: cursors\nservices:\n  web:\n    routes:\n      - hostname: added.test\n        port: 82\n      - hostname: inherited.test\n        port: 83\n",
    );
    await Bun.write(
      join(root, ".lando.local.yml"),
      "services:\n  other: !override\n    working_dir: /authored\n    environment:\n      DROPPED: !reset\n",
    );
    // When: fold native directives and canonical aliases.
    const { merged } = await Effect.runPromise(composeLandofileRootLayers(root, inputs));
    // Then: authored cursor equality holds without special cases for either transformation.
    expect(assertProvenance(merged)).toBeGreaterThanOrEqual(6);
    expect(exactOriginAt(getOrigins(merged), ["services", "other", "workingDirectory"]).source.path).toEqual([
      "services",
      "other",
      "working_dir",
    ]);
    expect(exactOriginAt(getOrigins(merged), ["services", "web", "routes", 0, "port"]).source.path).toEqual([
      "services",
      "web",
      "routes",
      1,
      "port",
    ]);
  });
});
