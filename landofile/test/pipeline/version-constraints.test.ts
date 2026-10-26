import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { getSourceDocuments } from "../../src/pipeline/source-table.ts";
import { loadLandofileLayers } from "../../src/service.ts";
import * as validation from "../../src/validation.ts";
import {
  evaluateVersionConstraints,
  getVersionConstraintEntries,
  rememberVersionConstraintEntries,
} from "../../src/version-constraint.ts";
import { resolveAuthoredIncludes } from "../include-pipeline.ts";
import { makeTestLandofilePorts, makeTestLandofileStateStore } from "../support.ts";

const withApp = async <T>(files: Readonly<Record<string, string>>, use: (root: string) => Promise<T>) => {
  const root = await mkdtemp(join(tmpdir(), "lando-version-materialization-"));
  try {
    for (const [file, content] of Object.entries(files)) await Bun.write(join(root, file), content);
    return await use(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const load = (root: string, env: Readonly<Record<string, string>> = {}) =>
  loadLandofileLayers(root, join(root, ".lando.yml"), {
    ports: makeTestLandofilePorts(root),
    stateStore: makeTestLandofileStateStore(),
    templates: { modules: [], context: { env, scope: "app", bootstrapLevel: "plugins" } },
  });

test("resolves an env range before validating and remembering it", async () => {
  // Given an actual YAML source, not a pre-materialized document.
  await withApp({ ".lando.yml": 'name: range\nlando: "{{ env.RANGE }}"\n' }, async (root) => {
    const calls = spyOn(validation, "validateLandofile");
    try {
      // When
      const loaded = await Effect.runPromise(load(root, { RANGE: ">=4 <5" }));
      // Then runtime consumers receive the resolved range after exactly one strict decode.
      expect(loaded.document.lando).toBe(">=4 <5");
      expect(getVersionConstraintEntries(loaded.document, "unused")).toEqual([
        { range: ">=4 <5", source: join(root, ".lando.yml"), layer: "canonical", order: 3 },
      ]);
      expect(calls).toHaveBeenCalledTimes(1);
      expect(getSourceDocuments(loaded)[0]?.document).toMatchObject({ lando: "{{ env.RANGE }}" });
    } finally {
      calls.mockRestore();
    }
  });
});

test("resolves every shadowed layer and nested include range against merged recipe options", async () => {
  // Given six layers and two included sources; local recipe options win over the base value.
  await withApp(
    {
      ".lando.base.yml": 'lando: "{{ recipe.range }}"\nrecipe:\n  options:\n    range: ">=99"\n',
      ".lando.dist.yml": 'lando: "{{ env.DIST }}"\n',
      ".lando.upstream.yml": 'lando: ">=4.1"\n',
      ".lando.yml": [
        "name: ranges",
        'lando: "^4"',
        "includes:",
        "  - first.yml",
        "recipe:",
        "  id: lamp",
        '  version: "0.1.0"',
        "  producer:",
        "    sourceKind: bundled",
        '    packageName: "@lando/recipe-lamp"',
        "    recipeId: lamp",
        '    manifestVersion: "0.1.0"',
        `    contentDigest: "sha256:${"0".repeat(64)}"`,
      ].join("\n"),
      ".lando.local.yml": 'lando: "{{ env.LOCAL }}"\nrecipe:\n  options:\n    range: ">=4.2"\n',
      ".lando.user.yml": 'lando: "*"\n',
      "first.yml": 'lando: "{{ recipe.range }}"\nincludes:\n  - second.yml\n',
      "second.yml": 'lando: "{{ env.NESTED }}"\n',
    },
    async (root) => {
      const calls = spyOn(validation, "validateLandofile");
      try {
        // When
        const loaded = await Effect.runPromise(load(root, { DIST: "<5", LOCAL: ">=4.3", NESTED: "<4.5" }));
        const entries = getVersionConstraintEntries(loaded.document, "unused");
        // Then the winning wildcard does not discard any lower constraint or its attribution.
        expect(loaded.document.lando).toBe("*");
        expect(entries).toEqual([
          { range: ">=4.2", source: join(root, ".lando.base.yml"), layer: "base", order: 0 },
          { range: "<5", source: join(root, ".lando.dist.yml"), layer: "dist", order: 1 },
          { range: ">=4.1", source: join(root, ".lando.upstream.yml"), layer: "upstream", order: 2 },
          { range: "<4.5", source: join(root, "second.yml"), layer: "canonical", order: 3 },
          { range: ">=4.2", source: join(root, "first.yml"), layer: "canonical", order: 3 },
          { range: "^4", source: join(root, ".lando.yml"), layer: "canonical", order: 3 },
          { range: ">=4.3", source: join(root, ".lando.local.yml"), layer: "local", order: 4 },
          { range: "*", source: join(root, ".lando.user.yml"), layer: "user", order: 5 },
        ]);
        expect(evaluateVersionConstraints(entries, "4.2.0").unsatisfied.map(({ source }) => source)).toEqual([
          join(root, ".lando.local.yml"),
        ]);
        expect(evaluateVersionConstraints(entries, "4.6.0").unsatisfied.map(({ source }) => source)).toEqual([
          join(root, "second.yml"),
        ]);
        expect(calls).toHaveBeenCalledTimes(1);
        expect(getSourceDocuments(loaded)).toHaveLength(8);
      } finally {
        calls.mockRestore();
      }
    },
  );
});

test.each([".lando.base.yml", ".lando.local.yml", "fragment.yml"])(
  "reports the invalid resolved range from %s even when a wildcard shadows it",
  async (source) => {
    // Given
    await withApp(
      {
        ".lando.yml": "name: invalid\nincludes:\n  - fragment.yml\n",
        "fragment.yml": "services: {}\n",
        [source]: 'lando: "{{ env.RANGE }}"\n',
        ".lando.user.yml": 'lando: "*"\n',
      },
      async (root) => {
        // When
        const error = await Effect.runPromise(load(root, { RANGE: "not-a-range" }).pipe(Effect.flip));
        // Then neither the raw expression nor the final wildcard hides the source's invalid range.
        expect(error).toMatchObject({
          _tag: "LandofileParseError",
          filePath: join(root, source),
          message: expect.stringContaining('"not-a-range"'),
        });
      },
    );
  },
);

test("does not reinterpret a shadowed file-produced range as an env expression", async () => {
  // Given load() produces literal text that would otherwise resolve to a valid range.
  await withApp(
    {
      ".lando.base.yml": "lando: \"{{ load('./range.txt') }}\"\n",
      ".lando.yml": 'name: literal\nlando: "*"\n',
      "range.txt": "{{ env.RANGE }}",
    },
    async (root) => {
      // When
      const error = await Effect.runPromise(load(root, { RANGE: ">=4" }).pipe(Effect.flip));
      // Then literal produced text is rejected, not evaluated a second time.
      expect(error).toMatchObject({ _tag: "LandofileParseError", filePath: join(root, ".lando.base.yml") });
    },
  );
});

test("attributes an unresolved shadowed range to its original layer and path", async () => {
  // Given
  await withApp(
    { ".lando.base.yml": 'lando: "{{ env.MISSING }}"\n', ".lando.yml": 'name: missing\nlando: "*"\n' },
    async (root) => {
      // When
      const error = await Effect.runPromise(load(root).pipe(Effect.flip));
      // Then
      expect(error).toMatchObject({
        _tag: "ConfigExpressionError",
        filePath: join(root, ".lando.base.yml"),
        path: "lando",
        expression: "{{ env.MISSING }}",
      });
    },
  );
});

test("rejects a non-string resolved range without throwing an untyped error", async () => {
  // Given
  await withApp(
    { ".lando.base.yml": 'lando: "{{ number(env.RANGE) }}"\n', ".lando.yml": 'name: typed\nlando: "*"\n' },
    async (root) => {
      // When
      const error = await Effect.runPromise(load(root, { RANGE: "4" }).pipe(Effect.flip));
      // Then
      expect(error).toMatchObject({ _tag: "LandofileParseError", filePath: join(root, ".lando.base.yml") });
    },
  );
});

test("keeps remembered source constraints while acquiring nested includes", async () => {
  // Given a decoded root whose visible wildcard shadows two remembered sources.
  await withApp(
    {
      "outer.yml": 'lando: ">=1.2.0"\nincludes:\n  - inner.yml\n',
      "inner.yml": 'lando: "<9.0.0"\n',
    },
    async (root) => {
      const base = join(root, ".lando.base.yml");
      const user = join(root, ".lando.user.yml");
      const landofile = rememberVersionConstraintEntries(
        { name: "provenance", lando: "*", includes: ["outer.yml"] },
        [
          { range: ">=99", source: base, layer: "base", order: 0 },
          { range: "*", source: user, layer: "user", order: 5 },
        ],
      );

      // When includes are acquired under that same object.
      const loaded = await Effect.runPromise(
        resolveAuthoredIncludes({
          landofile,
          appRoot: root,
          sourcePath: join(root, ".lando.yml"),
          stateStore: makeTestLandofileStateStore(),
          ports: makeTestLandofilePorts(root),
          cacheRoot: root,
        }),
      );

      // Then neither source is retargeted, dropped, or replayed, and nested ranges stay.
      expect(loaded.lando).toBe("*");
      expect(getVersionConstraintEntries(loaded, "unused")).toEqual([
        { range: "<9.0.0", source: join(root, "inner.yml"), layer: "canonical", order: 3 },
        { range: ">=1.2.0", source: join(root, "outer.yml"), layer: "canonical", order: 3 },
        { range: ">=99", source: base, layer: "base", order: 0 },
        { range: "*", source: user, layer: "user", order: 5 },
      ]);
    },
  );
});
