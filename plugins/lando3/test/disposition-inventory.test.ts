import { describe, expect, test } from "bun:test";
import { isLegacyTagged, parseLegacyLandofile } from "@lando/sdk/landofile";
import { createRedactor } from "@lando/sdk/secrets";
import { Effect } from "effect";
import { isPlainObject } from "../src/lowering-contract.ts";
import { makeLando3ConfigTranslator } from "../src/translator.ts";
import { type Golden, dispositionInventory, referenceVariants } from "./fixtures/disposition-inventory.ts";
import { document, documentSet, fakeDecomposers } from "./fixtures/fake-decomposers.ts";

type Path = ReadonlyArray<string | number>;
const translate = (yaml: string) => {
  const translator = makeLando3ConfigTranslator({
    decomposers: fakeDecomposers().decomposers,
    redactor: createRedactor("secrets"),
  });
  return Effect.runPromise(Effect.either(translator.translate(documentSet([document(".lando.yml", yaml)]))));
};
const assertHosterRejection = (
  error: { readonly _tag: string; readonly cause?: unknown },
  golden: Golden,
): void => {
  expect(golden.expect).toEqual({ kind: "unsupported", keyPath: ["recipe"] });
  expect(error._tag).toBe("ConfigTranslateError");
  expect(error.cause).toMatchObject({
    _tag: "Lando3UnsupportedRecipeError",
    reason: "hoster",
    keyPath: ["recipe"],
  });
  expect(error).not.toHaveProperty("outputs");
};
const walk = (value: unknown, path: Path = []): ReadonlyArray<Path> => {
  if (isLegacyTagged(value)) return [path]; // A tag is one authored value, not marker metadata.
  const children: ReadonlyArray<readonly [string | number, unknown]> = Array.isArray(value)
    ? Array.from(value.entries())
    : isPlainObject(value)
      ? Object.entries(value)
      : [];
  return [
    ...(path.length === 0 ? [] : [path]),
    ...children.flatMap(([key, child]) => walk(child, [...path, key])),
  ];
};
const matches = (pattern: ReadonlyArray<string>, path: Path): boolean =>
  pattern.length <= path.length &&
  pattern.every((part, index) => part === "*" || part === String(path[index]));
const parseFixture = async (basename: string) => {
  const file = `${import.meta.dir}/fixtures/lando3/${basename}`;
  return Effect.runSync(parseLegacyLandofile({ mode: "legacy", file, content: await Bun.file(file).text() }))
    .value;
};
const inventoryPaths = async (): Promise<ReadonlyArray<Path>> => {
  const landofile = await parseFixture("kitchen-sink.lando.yml");
  const global = await parseFixture("kitchen-sink.config.yml");
  expect(isPlainObject(global)).toBe(true);
  return [
    ...walk(landofile),
    ...Object.keys(isPlainObject(global) ? global : {}).map((key) => [key]),
    ...referenceVariants.map((key) => [key]),
  ];
};
const atPath = (value: unknown, path: ReadonlyArray<string>): unknown => {
  if (path.length === 0) return value;
  const [key, ...rest] = path;
  if (key === undefined) return value;
  if (Array.isArray(value)) return atPath(value[Number(key)], rest);
  return isPlainObject(value) ? atPath(value[key], rest) : undefined;
};
const residuals = (value: unknown): ReadonlyArray<Path> =>
  walk(value).filter((path) => {
    // Extension bags and recipe provenance are inert metadata, not runtime service settings.
    if (String(path[0]).startsWith("x-") || path[0] === "recipe") return false;
    const key = path.at(-1);
    return (
      [
        "overrides",
        "build_as_root",
        "run_as_root",
        "build_internal",
        "run_internal",
        "build_as_root_internal",
        "run_as_root_internal",
        "portforward",
        "moreHttpPorts",
        "meUser",
        "app_mount",
        "app-mount",
        "composer_version",
        "persistent-storage",
        "sslExpose",
      ].includes(String(key)) ||
      (key === "xdebug" && isPlainObject(atPath(value, path.map(String))))
    );
  });

describe("Lando 3 disposition inventory", () => {
  test("every authored path has exactly one longest-pattern owner", async () => {
    // Given both independently authored inventories and the reference variants.
    const paths = await inventoryPaths();
    expect(paths.length).toBeGreaterThan(500);
    // When all ancestor patterns compete, only the longest may win.
    const failures = paths.flatMap((path) => {
      const candidates = dispositionInventory.filter(({ pattern }) => matches(pattern, path));
      const length = Math.max(-1, ...candidates.map(({ pattern }) => pattern.length));
      const winners = candidates.filter(({ pattern }) => pattern.length === length);
      return winners.length === 1
        ? []
        : [{ path, owners: winners.map(({ pattern, owner }) => ({ pattern, owner })) }];
    });
    // Then missing ownership and equal-length ambiguity are both visible.
    expect(failures).toEqual([]);
  });
  test("every entry has a disposition-aligned golden and a module owner", async () => {
    // Given the independently maintained table; when checking its contracts.
    for (const entry of dispositionInventory) {
      expect(entry.pattern.length).toBeGreaterThan(0);
      expect(entry.owner).toMatch(/^[a-z][a-z0-9-]*$/);
      expect(await Bun.file(`${import.meta.dir}/../src/${entry.owner}.ts`).exists(), entry.owner).toBe(true);
      expect(entry.golden.length).toBeGreaterThan(0);
      const aligned = entry.golden.some(({ expect: expected }) => {
        switch (entry.disposition) {
          case "target":
            return "outputPath" in expected || expected.kind === "rewritten" || expected.kind === "generated";
          case "drop":
            return "kind" in expected && (expected.kind === "dropped" || expected.kind === "needs-review");
          case "unsupported":
            return "kind" in expected && expected.kind === "unsupported";
          default:
            return entry.disposition satisfies never;
        }
      });
      // Then a negative/value-variant example cannot stand in for the disposition.
      expect(aligned, JSON.stringify(entry.pattern)).toBe(true);
      if (!/^(cli|env):/.test(entry.pattern[0] ?? "")) {
        const exercised = entry.golden.some(({ yaml }) => {
          const parsed = Effect.runSync(
            parseLegacyLandofile({ mode: "legacy", file: ".lando.yml", content: yaml }),
          );
          return walk(parsed.value).some((path) => matches(entry.pattern, path));
        });
        expect(exercised, JSON.stringify(entry.pattern)).toBe(true);
      }
    }
  });
  test("every pattern is used by the authored inventory or a reference pseudo-path", async () => {
    // Given the source inventories; when matching each ledger row.
    const paths = await inventoryPaths();
    const unused = dispositionInventory.filter(
      ({ pattern }) => !paths.some((path) => matches(pattern, path)),
    );
    // Then typoed and stale entries fail rather than supplying pretend coverage.
    expect(unused.map(({ pattern }) => pattern)).toEqual([]);
  });

  for (const entry of dispositionInventory) {
    for (const [index, golden] of entry.golden.entries()) {
      const label = `${entry.pattern.join("/")} [${entry.owner}] ${index}: ${golden.name}`;
      test(`golden ${label}`, async () => {
        // Given a minimal real document and the supported recipe test port.
        // When translating through the production document-set boundary.
        const translated = await translate(golden.yaml);
        switch (translated._tag) {
          case "Left":
            assertHosterRejection(translated.left, golden);
            return;
          case "Right":
            break;
          default:
            return translated satisfies never;
        }
        const result = translated.right;
        // Then assert a diagnostic at the exact authored path, or the output fragment.
        if ("kind" in golden.expect) {
          const expected = golden.expect;
          const found = result.diagnostics.filter(
            ({ kind, keyPath }) =>
              kind === expected.kind && JSON.stringify(keyPath) === JSON.stringify(expected.keyPath),
          );
          expect(
            found,
            JSON.stringify(result.diagnostics.map(({ kind, keyPath }) => ({ kind, keyPath }))),
          ).toHaveLength(1);
          if (entry.pattern[0]?.startsWith("cli:") || entry.pattern[0]?.startsWith("env:")) {
            expect(
              result.diagnostics.filter(
                ({ kind, keyPath }) =>
                  (kind === "unsupported" || kind === "needs-review") &&
                  JSON.stringify(keyPath) === JSON.stringify(expected.keyPath),
              ),
            ).toHaveLength(1);
          }
        } else {
          const expected = golden.expect;
          const values = result.outputs
            .map(({ fragment }) => atPath(fragment, expected.outputPath))
            .filter((value) => value !== undefined);
          expect(values.length, JSON.stringify(result.diagnostics)).toBeGreaterThan(0);
          if (Object.hasOwn(expected, "value")) {
            expect(values.some((value) => Bun.deepEquals(value, expected.value))).toBe(true);
          }
        }
      });
      test(`no residual bag ${label}`, async () => {
        // Given the same golden, including rejected inputs; when translating.
        const translated = await translate(golden.yaml);
        // Then every emitted layer is free of runtime-only legacy keys.
        switch (translated._tag) {
          case "Left":
            assertHosterRejection(translated.left, golden);
            break;
          case "Right":
            expect(translated.right.outputs.flatMap(({ fragment }) => residuals(fragment))).toEqual([]);
            break;
          default:
            translated satisfies never;
        }
      });
    }
  }
});
