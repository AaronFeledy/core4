import { describe, expect, test } from "bun:test";
import { type ConfigTranslateDiagnostic, ConfigTranslateSourceId } from "@lando/sdk/schema";
import type { LegacyOccurrence } from "../src/contract.ts";
import {
  type ServiceLoweringContext,
  asStringArray,
  blockedPatch,
  emptyPatch,
  isPlainObject,
  mergePatches,
} from "../src/lowering-contract.ts";
import {
  deferredServiceKey,
  droppedServiceKey,
  generatedService,
  missingImage,
  needsReviewServiceKey,
  nonPortableServiceKey,
  rejectedComposeKey,
  rewrittenServiceKey,
  unsafeBuildSource,
  unsupportedServiceKey,
  unsupportedVersion,
} from "../src/service-diagnostics.ts";

const occurrence: LegacyOccurrence = {
  sourceId: ConfigTranslateSourceId.make(".lando.local.yml"),
  layer: "local",
  keyPath: ["services", "web", "overrides", "tty"],
  span: {
    start: { line: 4, column: 3, offset: 20 },
    end: { line: 4, column: 12, offset: 29 },
  },
};
const context = (located: LegacyOccurrence | undefined): ServiceLoweringContext => ({
  serviceName: "web",
  keyPath: ["services", "web"],
  fallbackSourceId: ".lando.yml",
  occurrenceAt: () => located,
  topLevel: { excludes: [], includes: [] },
});
const ctx = context(occurrence);
const diagnostic = deferredServiceKey({ ctx, relative: ["scanner"] });

describe("lowering patches", () => {
  test("deep merges objects and replaces arrays when later contributions overlap", () => {
    // Given
    const first = {
      patch: { environment: { A: "old", B: "kept" }, ports: [80], value: { old: true } },
      companions: { nginx: { environment: { A: "old" }, ports: [80] } },
      topLevel: { tooling: { run: { service: "web", cmd: ["old"] } } },
      diagnostics: [],
    };
    // When
    const result = mergePatches(first, {
      patch: { environment: { A: "new" }, ports: [443], value: false },
      companions: { nginx: { environment: { B: "new" }, ports: [443] } },
      topLevel: { tooling: { run: { cmd: ["new"] } } },
      diagnostics: [],
    });
    // Then
    expect(result).toEqual({
      patch: { environment: { A: "new", B: "kept" }, ports: [443], value: false },
      companions: { nginx: { environment: { A: "old", B: "new" }, ports: [443] } },
      topLevel: { tooling: { run: { service: "web", cmd: ["new"] } } },
      diagnostics: [],
    });
    expect(first.patch.environment.A).toBe("old");
  });

  test("concatenates mounts and build steps when later contributions add more", () => {
    // Given two patches that each add mounts and artifact steps.
    const first = {
      patch: { mounts: [{ target: "/a" }], build: { artifact: [{ run: "first" }] }, ports: [80] },
      diagnostics: [],
    };
    // When merged.
    const result = mergePatches(first, {
      patch: {
        mounts: [{ target: "/b" }],
        build: { artifact: [{ run: "second" }], app: [{ run: "app" }] },
        ports: [443],
      },
      diagnostics: [],
    });
    // Then list-shaped build and mount contributions accumulate, while other arrays still replace.
    expect(result.patch).toEqual({
      mounts: [{ target: "/a" }, { target: "/b" }],
      build: { artifact: [{ run: "first" }, { run: "second" }], app: [{ run: "app" }] },
      ports: [443],
    });
  });

  test("concatenates diagnostics in argument order and retains an earlier block", () => {
    // Given
    const later = { ...diagnostic, keyPath: ["services", "web", "ssl"] };
    // When
    const result = mergePatches(blockedPatch([diagnostic]), { patch: {}, diagnostics: [later] });
    // Then
    expect(result).toEqual({ patch: {}, diagnostics: [diagnostic, later], blocked: true });
  });

  test("retains a later block when earlier patches are empty", () => {
    // Given / When
    const result = mergePatches(emptyPatch, blockedPatch([diagnostic]));
    // Then
    expect(result).toEqual({ patch: {}, diagnostics: [diagnostic], blocked: true });
  });

  test("returns the empty patch when no contributions exist", () => {
    // Given / When
    const result = mergePatches();
    // Then
    expect(result).toEqual(emptyPatch);
    expect(emptyPatch).toEqual({ patch: {}, diagnostics: [] });
  });

  test("blocks without emitting fields when diagnostics are supplied", () => {
    // Given / When
    const result = blockedPatch([diagnostic]);
    // Then
    expect(result).toEqual({ patch: {}, diagnostics: [diagnostic], blocked: true });
  });

  test.each([
    ["one", ["one"]],
    [
      ["one", "two"],
      ["one", "two"],
    ],
    [[], []],
    [["one", 2], undefined],
    [null, undefined],
    [42, undefined],
    [{}, undefined],
  ])("normalizes string input %j", (input, expected) => {
    // Given / When
    const result = asStringArray(input);
    // Then
    expect(result).toEqual(expected);
  });

  test.each([
    [{}, true],
    [Object.create(null), true],
    [[], false],
    [null, false],
    [new Date(0), false],
    [new Map(), false],
    ["text", false],
  ])("recognizes only plain objects for %j", (input, expected) => {
    // Given / When
    const result = isPlainObject(input);
    // Then
    expect(result).toBe(expected);
  });
});

const factories: ReadonlyArray<
  readonly [
    string,
    ConfigTranslateDiagnostic["kind"],
    (ctx: ServiceLoweringContext) => ConfigTranslateDiagnostic,
  ]
> = [
  ...(
    [
      ["dropped", droppedServiceKey],
      ["unsupported", unsupportedServiceKey],
      ["rewritten", rewrittenServiceKey],
      ["non-portable", nonPortableServiceKey],
      ["needs-review", needsReviewServiceKey],
      ["generated", generatedService],
    ] as const
  ).map(
    ([kind, factory]) =>
      [
        kind,
        kind,
        (ctx: ServiceLoweringContext) =>
          factory({
            ctx,
            relative: ["overrides", "tty"],
            message: "Changed setting.",
            remediation: "Review setting.",
          }),
      ] as const,
  ),
  ["deferred", "unsupported", (ctx) => deferredServiceKey({ ctx, relative: ["scanner"] })],
  [
    "version",
    "unsupported",
    (ctx) =>
      unsupportedVersion({
        ctx,
        relative: ["type"],
        type: "php",
        version: "7.4",
        supported: ["8.3"],
      }),
  ],
  ["image", "unsupported", (ctx) => missingImage({ ctx })],
  [
    "compose",
    "unsupported",
    (ctx) => rejectedComposeKey({ ctx, relative: ["overrides", "tty"], key: "tty" }),
  ],
  [
    "build",
    "unsupported",
    (ctx) => unsafeBuildSource({ ctx, relative: ["build"], detail: "Remote source." }),
  ],
];

describe("service diagnostics", () => {
  for (const [name, kind, factory] of factories) {
    for (const located of [occurrence, { ...occurrence, span: undefined }, undefined]) {
      test(`${name} preserves provenance when occurrence is ${located === undefined ? "absent" : located.span === undefined ? "unlocated" : "located"}`, () => {
        // Given
        const paths: unknown[] = [];
        const ctx = {
          ...context(located),
          occurrenceAt: (relative: readonly (string | number)[]) => {
            paths.push(relative);
            return located;
          },
        };
        // When
        const result = factory(ctx);
        // Then
        expect(result.kind).toBe(kind);
        expect(result.keyPath.slice(0, 2)).toEqual(["services", "web"]);
        expect(paths).toEqual([result.keyPath.slice(2)]);
        expect(result.sourceId).toBe(located?.sourceId ?? ConfigTranslateSourceId.make(".lando.yml"));
        expect(result.remediation?.trim().length).toBeGreaterThan(0);
        expect(result.span).toEqual(
          located?.span === undefined
            ? undefined
            : {
                start: { line: 4, column: 3 },
                end: { line: 4, column: 12 },
              },
        );
        if (name === "image") expect(result.keyPath).toEqual(["services", "web"]);
      });
    }
  }

  test("names the full deferred path when it has no target", () => {
    // Given / When
    const result = deferredServiceKey({ ctx, relative: ["build", 0] });
    // Then
    expect(result.message).toBe("services.web.build[0] has no Lando 4 target yet.");
  });
});
