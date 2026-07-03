import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

import { scanModuleEdges } from "../../../scripts/module-edge-scan.ts";

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreSrc = resolve(repoRoot, "core/src");
const sdkSrc = resolve(repoRoot, "sdk/src");
const pluginsRoot = resolve(repoRoot, "plugins");

/**
 * Canonical OCLIF code-path location. OCLIF
 * lives ONLY under `@lando/core/oclif` (`core/src/cli/oclif/**`). Reaching any
 * file under this directory — or importing the `@oclif/*` npm packages — from a
 * non-OCLIF entry point is a library import-boundary violation.
 */
const oclifCodePathDir = `${resolve(coreSrc, "cli/oclif")}/`;
const tuiCodePathDirs = [
  `${resolve(coreSrc, "cli/tui")}/`,
  `${resolve(coreSrc, "cli/renderer/tui")}/`,
  `${resolve(coreSrc, "tui")}/`,
];
const tuiCodePathFiles = [
  resolve(coreSrc, "cli/renderer/task-tree-tail.ts"),
  resolve(coreSrc, "cli/renderer/keybindings.ts"),
];
const isTuiCodePath = (absPath: string): boolean =>
  tuiCodePathDirs.some((dir) => absPath.startsWith(dir)) || tuiCodePathFiles.includes(absPath);

const firstPartySourceRoots = [`${coreSrc}/`, `${sdkSrc}/`, `${pluginsRoot}/`] as const;

const isFirstPartySource = (absPath: string): boolean =>
  firstPartySourceRoots.some((root) => absPath.startsWith(root));

const isOclifNpmSpecifier = (specifier: string): boolean =>
  specifier === "@oclif/core" || specifier.startsWith("@oclif/");

const isTuiNpmSpecifier = (specifier: string): boolean =>
  specifier === "opentui" || specifier === "@opentui/core" || specifier.startsWith("@opentui/");

const isEffectNpmSpecifier = (specifier: string): boolean =>
  specifier === "effect" || specifier.startsWith("effect/");

/** Follow only first-party static edges: relative paths and `@lando/*` packages. */
const isFollowableSpecifier = (specifier: string): boolean =>
  specifier.startsWith(".") || specifier.startsWith("@lando/");

const repoRelative = (absPathOrSpecifier: string): string =>
  absPathOrSpecifier.startsWith("/") ? relative(repoRoot, absPathOrSpecifier) : absPathOrSpecifier;

/**
 * Pure classifier: decides whether a single resolved static import edge crosses
 * the OCLIF boundary. Returns a human-readable reason, or `undefined` when the
 * edge is OCLIF-free. Exercised directly by unit tests so both detection signals
 * are proven load-bearing without needing a real boundary violation to exist.
 */
const classifyOclifImport = (edge: {
  readonly importerAbs: string;
  readonly specifier: string;
  readonly resolvedAbs: string | undefined;
}): string | undefined => {
  // Signal A: a direct import of the `@oclif/*` npm package, from anywhere in
  // the followed first-party graph.
  if (isOclifNpmSpecifier(edge.specifier)) {
    return `imports the OCLIF npm package "${edge.specifier}"`;
  }
  // Signal B: a non-OCLIF first-party module reaching into the OCLIF code-path
  // directory. Edges *within* `core/src/cli/oclif/**` are internal to the OCLIF
  // surface and are not themselves boundary violations.
  if (edge.resolvedAbs?.startsWith(oclifCodePathDir) && !edge.importerAbs.startsWith(oclifCodePathDir)) {
    return `reaches the OCLIF code path ${repoRelative(edge.resolvedAbs)}`;
  }
  return undefined;
};

const classifyTuiImport = (edge: {
  readonly importerAbs: string;
  readonly specifier: string;
  readonly resolvedAbs: string | undefined;
}): string | undefined => {
  if (isTuiNpmSpecifier(edge.specifier)) {
    return `imports the TUI npm package "${edge.specifier}"`;
  }
  if (edge.resolvedAbs !== undefined && isTuiCodePath(edge.resolvedAbs) && !isTuiCodePath(edge.importerAbs)) {
    return `reaches the TUI code path ${repoRelative(edge.resolvedAbs)}`;
  }
  return undefined;
};

// Flags a direct static import of `effect` (or any `effect/*` submodule). The
// runtime is external-only, so a single specifier check suffices. `import type`
// edges are erased by `Bun.Transpiler().scan()` first, so type-only Effect
// references never count as a runtime dependency.
const classifyEffectImport = (edge: { readonly specifier: string }): string | undefined =>
  isEffectNpmSpecifier(edge.specifier) ? `imports the Effect runtime package "${edge.specifier}"` : undefined;

interface OclifViolation {
  /** Import chain from the walked entry to the offending module/specifier. */
  readonly chain: ReadonlyArray<string>;
  readonly reason: string;
}

interface TuiViolation {
  readonly chain: ReadonlyArray<string>;
  readonly reason: string;
}

interface EffectViolation {
  readonly chain: ReadonlyArray<string>;
  readonly reason: string;
}

const transpilers = {
  ts: new Bun.Transpiler({ loader: "ts" }),
  tsx: new Bun.Transpiler({ loader: "tsx" }),
} as const;

const scanStaticImports = (absPath: string, source: string): ReadonlyArray<string> => {
  const transpiler = absPath.endsWith(".tsx") ? transpilers.tsx : transpilers.ts;
  // `transpiler.scan` erases `import type` / `export type` (type-only edges are
  // never emitted) and tags lazy `import()` as `dynamic-import`. Keeping only
  // `import-statement` therefore yields exactly the eagerly-evaluated static
  // value graph — the modules an embedding host actually loads.
  return transpiler
    .scan(source)
    .imports.filter((entry) => entry.kind === "import-statement")
    .map((entry) => entry.path);
};

const resolveFirstParty = (specifier: string, importerAbs: string): string | undefined => {
  try {
    return realpathSync(Bun.resolveSync(specifier, dirname(importerAbs)));
  } catch {
    return undefined;
  }
};

/**
 * Sanctioned lazy-loading boundaries: dynamic imports of otherwise-banned
 * packages that are the DESIGN (constructed specifiers hiding heavy native
 * deps from the bundler). Key format: `<repo-relative importer> -> <specifier>`.
 */
const DYNAMIC_IMPORT_ALLOWLIST: ReadonlySet<string> = new Set([
  "plugins/renderer-lando/src/opentui/prompt-driver.ts -> @opentui/core",
]);

type DynamicViolationFamily = "oclif" | "tui" | "effect";

interface DynamicEdgeRecord {
  readonly importerAbs: string;
  readonly specifier: string;
  readonly family: DynamicViolationFamily;
  readonly reason: string;
}

const dynamicEdgeCache = new Map<string, ReadonlyArray<{ specifier: string }>>();

// Fast-path hint that a source MIGHT contain a dynamic edge. Whitespace (and
// line breaks) are legal between the keyword and `(`, so a bare substring
// check on `import(` would skip valid dynamic imports. Over-matching is fine —
// the AST scan below is the authority; this only gates whether it runs.
const dynamicEdgeHint = /\b(?:import|require)\s*\(/;

const scanDynamicEdges = (absPath: string, source: string): ReadonlyArray<{ specifier: string }> => {
  const cached = dynamicEdgeCache.get(absPath);
  if (cached !== undefined) return cached;
  const edges = dynamicEdgeHint.test(source)
    ? scanModuleEdges(absPath, source)
        .filter((edge) => edge.kind === "dynamic-import" || edge.kind === "require")
        .map((edge) => ({ specifier: edge.specifier }))
    : [];
  dynamicEdgeCache.set(absPath, edges);
  return edges;
};

const classifyDynamicEdge = (edge: {
  readonly importerAbs: string;
  readonly specifier: string;
  readonly resolvedAbs: string | undefined;
}): { family: DynamicViolationFamily; reason: string } | undefined => {
  const oclifReason = classifyOclifImport(edge);
  if (oclifReason !== undefined) return { family: "oclif", reason: oclifReason };
  const tuiReason = classifyTuiImport(edge);
  if (tuiReason !== undefined) return { family: "tui", reason: tuiReason };
  const effectReason = classifyEffectImport(edge);
  if (effectReason !== undefined) return { family: "effect", reason: effectReason };
  return undefined;
};

/**
 * Walk the LAZY module closure rooted at `entryAbs`: follow both static
 * imports and statically resolvable dynamic `import()` edges across
 * first-party modules, and classify every dynamic edge against the banned-
 * dependency classifiers. Unlike {@link walkStaticImportGraph} (the eager
 * graph the boundary assertions freeze), this closure exists to catch a
 * banned dependency slipping past the gate via `await import(...)` — the
 * sanctioned lazy boundaries live in {@link DYNAMIC_IMPORT_ALLOWLIST}.
 */
const walkLazyModuleGraph = (
  entryAbs: string,
): {
  readonly visited: ReadonlySet<string>;
  readonly dynamicViolations: ReadonlyArray<DynamicEdgeRecord>;
  readonly allowlistedDynamicEdges: ReadonlyArray<DynamicEdgeRecord>;
} => {
  const visited = new Set<string>();
  const dynamicViolations: DynamicEdgeRecord[] = [];
  const allowlistedDynamicEdges: DynamicEdgeRecord[] = [];

  const visit = (absPath: string): void => {
    if (visited.has(absPath)) return;
    visited.add(absPath);
    if (!/\.tsx?$/.test(absPath)) return;

    let source: string;
    try {
      source = readFileSync(absPath, "utf8");
    } catch {
      return;
    }

    const followEdge = (specifier: string): string | undefined =>
      isFollowableSpecifier(specifier) ? resolveFirstParty(specifier, absPath) : undefined;

    for (const specifier of scanStaticImports(absPath, source)) {
      const resolvedAbs = followEdge(specifier);
      if (resolvedAbs !== undefined && isFirstPartySource(resolvedAbs)) visit(resolvedAbs);
    }

    for (const edge of scanDynamicEdges(absPath, source)) {
      const resolvedAbs = followEdge(edge.specifier);
      const classified = classifyDynamicEdge({
        importerAbs: absPath,
        specifier: edge.specifier,
        resolvedAbs,
      });
      if (classified !== undefined) {
        const record: DynamicEdgeRecord = {
          importerAbs: absPath,
          specifier: edge.specifier,
          family: classified.family,
          reason: classified.reason,
        };
        const allowKey = `${repoRelative(absPath)} -> ${edge.specifier}`;
        if (DYNAMIC_IMPORT_ALLOWLIST.has(allowKey)) {
          allowlistedDynamicEdges.push(record);
        } else {
          dynamicViolations.push(record);
        }
      }
      if (resolvedAbs !== undefined && isFirstPartySource(resolvedAbs)) visit(resolvedAbs);
    }
  };

  visit(realpathSync(entryAbs));
  return { visited, dynamicViolations, allowlistedDynamicEdges };
};

/**
 * Walk the transitive STATIC import graph rooted at `entryAbs`, following only
 * first-party edges, and collect every edge that crosses the OCLIF boundary.
 * Each violation carries the full import chain so failure messages can name the
 * offending path.
 */
const walkStaticImportGraph = (
  entryAbs: string,
): {
  readonly visited: ReadonlySet<string>;
  readonly violations: ReadonlyArray<OclifViolation>;
  readonly tuiViolations: ReadonlyArray<TuiViolation>;
  readonly effectViolations: ReadonlyArray<EffectViolation>;
} => {
  const visited = new Set<string>();
  const violations: OclifViolation[] = [];
  const tuiViolations: TuiViolation[] = [];
  const effectViolations: EffectViolation[] = [];

  const visit = (absPath: string, chain: ReadonlyArray<string>): void => {
    if (visited.has(absPath)) return;
    visited.add(absPath);
    if (!/\.tsx?$/.test(absPath)) return;

    let source: string;
    try {
      source = readFileSync(absPath, "utf8");
    } catch {
      return;
    }

    for (const specifier of scanStaticImports(absPath, source)) {
      const resolvedAbs = isOclifNpmSpecifier(specifier)
        ? undefined
        : isFollowableSpecifier(specifier)
          ? resolveFirstParty(specifier, absPath)
          : undefined;

      const reason = classifyOclifImport({ importerAbs: absPath, specifier, resolvedAbs });
      if (reason !== undefined) {
        const offender = isOclifNpmSpecifier(specifier) ? specifier : (resolvedAbs ?? specifier);
        violations.push({ chain: [...chain, absPath, offender], reason });
        // Do not recurse past an `@oclif/*` package (external); for code-path
        // edges we still recurse below so deeper offenders surface too.
      }

      const tuiReason = classifyTuiImport({ importerAbs: absPath, specifier, resolvedAbs });
      if (tuiReason !== undefined) {
        const offender = isTuiNpmSpecifier(specifier) ? specifier : (resolvedAbs ?? specifier);
        tuiViolations.push({ chain: [...chain, absPath, offender], reason: tuiReason });
      }

      const effectReason = classifyEffectImport({ specifier });
      if (effectReason !== undefined) {
        effectViolations.push({ chain: [...chain, absPath, specifier], reason: effectReason });
      }

      if (resolvedAbs !== undefined && isFirstPartySource(resolvedAbs)) {
        visit(resolvedAbs, [...chain, absPath]);
      }
    }
  };

  visit(realpathSync(entryAbs), []);
  return { visited, violations, tuiViolations, effectViolations };
};

const formatViolation = (entrySpecifier: string, violation: OclifViolation): string => {
  const chain = violation.chain.map(repoRelative).join("\n      → ");
  return `${entrySpecifier} ${violation.reason} via:\n      ${chain}`;
};

const formatTuiViolation = (entrySpecifier: string, violation: TuiViolation): string => {
  const chain = violation.chain.map(repoRelative).join("\n      → ");
  return `${entrySpecifier} ${violation.reason} via:\n      ${chain}`;
};

const formatEffectViolation = (entrySpecifier: string, violation: EffectViolation): string => {
  const chain = violation.chain.map(repoRelative).join("\n      → ");
  return `${entrySpecifier} ${violation.reason} via:\n      ${chain}`;
};

const resolveEntrySource = (specifier: string): string => realpathSync(Bun.resolveSync(specifier, repoRoot));

interface CriticalEntryPoint {
  readonly specifier: string;
  readonly expectsOclif: boolean;
}

const CRITICAL_ENTRY_POINTS: CriticalEntryPoint[] = [
  { specifier: "@lando/core", expectsOclif: false },
  { specifier: "@lando/core/cli", expectsOclif: false },
  { specifier: "@lando/core/testing", expectsOclif: false },
  { specifier: "@lando/core/paths", expectsOclif: false },
  { specifier: "@lando/core/oclif", expectsOclif: true },
];

describe("import boundaries (basic importability)", () => {
  test("can import the default entry", async () => {
    const mod = await import("../../src/index.ts");
    expect(mod).toBeDefined();
    expect(mod.makeLandoRuntime).toBeDefined();
  });

  test("can import @lando/core/services without OCLIF", async () => {
    const mod = await import("../../src/services/index.ts");
    expect(mod.ConfigService).toBeDefined();
    expect(mod.RuntimeProvider).toBeDefined();
    expect(mod.EventService).toBeDefined();
  });

  test("@lando/core/services re-exports PathsService", async () => {
    const mod = (await import("@lando/core/services")) as Record<string, unknown>;
    expect(mod.PathsService).toBeDefined();
  });

  test("@lando/core/paths resolves from the package subpath export", async () => {
    const mod = (await import("@lando/core/paths")) as Record<string, unknown>;
    expect(mod.resolveLandoRoots).toBeDefined();
    expect(mod.makeLandoPaths).toBeDefined();
    expect(mod.normalizeHostPlatform).toBeDefined();
    expect(
      (
        mod.makeLandoPaths as (overrides: { readonly userDataRoot: string }) => {
          readonly managedFileLedger: (appId: string) => string;
        }
      )({
        userDataRoot: "/tmp/lando-data",
      }).managedFileLedger("app-one"),
    ).toBe("/tmp/lando-data/managed-files/app-one/ledger.json");
  });

  test("can import @lando/core/schema standalone", async () => {
    const mod = await import("../../src/schema/index.ts");
    expect(mod.GlobalConfig).toBeDefined();
    expect(mod.LandofileShape).toBeDefined();
    expect(mod.UpdateManifestSchema).toBeDefined();
  });

  test("can import @lando/core/errors standalone", async () => {
    const mod = await import("../../src/errors/index.ts");
    expect(mod.ConfigError).toBeDefined();
    expect(mod.NoProviderInstalledError).toBeDefined();
  });

  test("can import @lando/core/events standalone", async () => {
    const mod = await import("../../src/lifecycle/index.ts");
    expect(mod.PreStartEvent).toBeDefined();
    expect(mod.PostStartEvent).toBeDefined();
    expect(mod.SubscriberPriority).toBeDefined();
  });

  test("marks the library API as unstable/dev-channel only", async () => {
    const source = await readFile(new URL("../../src/index.ts", import.meta.url), "utf8");
    expect(source).toContain("unstable");
    expect(source).toContain("dev/next channels");
  });
});

describe("OCLIF import-boundary classifier (detection self-check)", () => {
  test("signal A: flags a direct @oclif/* npm import from anywhere", () => {
    expect(
      classifyOclifImport({
        importerAbs: resolve(coreSrc, "runtime/layer.ts"),
        specifier: "@oclif/core",
        resolvedAbs: undefined,
      }),
    ).toContain("@oclif/core");
    expect(
      classifyOclifImport({
        importerAbs: resolve(coreSrc, "services/event-service.ts"),
        specifier: "@oclif/plugin-help",
        resolvedAbs: undefined,
      }),
    ).toContain("OCLIF npm package");
  });

  test("signal B: flags a non-OCLIF module reaching into the OCLIF code path", () => {
    expect(
      classifyOclifImport({
        importerAbs: resolve(coreSrc, "runtime/layer.ts"),
        specifier: "../cli/oclif/command-base.ts",
        resolvedAbs: resolve(coreSrc, "cli/oclif/command-base.ts"),
      }),
    ).toContain("OCLIF code path");
  });

  test("does NOT flag OCLIF-internal edges (oclif importer → oclif file)", () => {
    expect(
      classifyOclifImport({
        importerAbs: resolve(coreSrc, "cli/oclif/index.ts"),
        specifier: "./command-base.ts",
        resolvedAbs: resolve(coreSrc, "cli/oclif/command-base.ts"),
      }),
    ).toBeUndefined();
  });

  test("does NOT flag ordinary first-party / external edges", () => {
    expect(
      classifyOclifImport({
        importerAbs: resolve(coreSrc, "index.ts"),
        specifier: "./runtime/layer.ts",
        resolvedAbs: resolve(coreSrc, "runtime/layer.ts"),
      }),
    ).toBeUndefined();
    expect(
      classifyOclifImport({
        importerAbs: resolve(coreSrc, "runtime/layer.ts"),
        specifier: "effect",
        resolvedAbs: undefined,
      }),
    ).toBeUndefined();
  });
});

describe("TUI import-boundary classifier (detection self-check)", () => {
  test("signal A: flags a direct @opentui/* npm import from anywhere", () => {
    expect(
      classifyTuiImport({
        importerAbs: resolve(coreSrc, "runtime/layer.ts"),
        specifier: "@opentui/core",
        resolvedAbs: undefined,
      }),
    ).toContain("@opentui/core");
  });

  test("signal B: flags a non-TUI module reaching into a TUI code path", () => {
    expect(
      classifyTuiImport({
        importerAbs: resolve(coreSrc, "runtime/layer.ts"),
        specifier: "../tui/renderer.ts",
        resolvedAbs: resolve(coreSrc, "tui/renderer.ts"),
      }),
    ).toContain("TUI code path");
  });

  test("signal B: flags a non-TUI module reaching the rich terminal renderer files", () => {
    expect(
      classifyTuiImport({
        importerAbs: resolve(coreSrc, "runtime/layer.ts"),
        specifier: "../cli/renderer/task-tree-tail.ts",
        resolvedAbs: resolve(coreSrc, "cli/renderer/task-tree-tail.ts"),
      }),
    ).toContain("TUI code path");
  });

  test("does NOT flag TUI-internal edges (tui file → tui file)", () => {
    expect(
      classifyTuiImport({
        importerAbs: resolve(coreSrc, "cli/renderer/keybindings.ts"),
        specifier: "./task-tree-tail.ts",
        resolvedAbs: resolve(coreSrc, "cli/renderer/task-tree-tail.ts"),
      }),
    ).toBeUndefined();
  });
});

describe("Effect import-boundary classifier (detection self-check)", () => {
  test("flags a direct effect npm import", () => {
    expect(classifyEffectImport({ specifier: "effect" })).toContain("Effect runtime");
  });

  test("flags an effect submodule import", () => {
    expect(classifyEffectImport({ specifier: "effect/Layer" })).toContain("effect/Layer");
  });

  test("does NOT flag ordinary first-party edges", () => {
    expect(classifyEffectImport({ specifier: "./overlay.ts" })).toBeUndefined();
    expect(classifyEffectImport({ specifier: "@lando/sdk/services" })).toBeUndefined();
  });
});

describe("OCLIF-free default entry", () => {
  test("the walker detects OCLIF when present (positive control on @lando/core/oclif)", () => {
    const entryAbs = resolveEntrySource("@lando/core/oclif");
    const { violations } = walkStaticImportGraph(entryAbs);

    expect(violations.length).toBeGreaterThan(0);

    const namesOclif = violations.some((violation) =>
      violation.chain.some((link) => link.startsWith("@oclif/") || repoRelative(link).includes("cli/oclif")),
    );
    expect(namesOclif).toBe(true);
  });

  test("the default @lando/core entry has an OCLIF-free transitive static import graph", () => {
    const entryAbs = resolveEntrySource("@lando/core");
    const { visited, violations } = walkStaticImportGraph(entryAbs);

    expect(visited.size).toBeGreaterThan(1);

    if (violations.length > 0) {
      const report = violations.map((violation) => formatViolation("@lando/core", violation)).join("\n\n");
      throw new Error(`@lando/core must not load any OCLIF code path; offending import chains:\n\n${report}`);
    }
    expect(violations.length).toBe(0);
  });

  test("the default @lando/core entry has a TUI-free transitive static import graph", () => {
    const entryAbs = resolveEntrySource("@lando/core");
    const { visited, tuiViolations } = walkStaticImportGraph(entryAbs);

    expect(visited.size).toBeGreaterThan(1);

    if (tuiViolations.length > 0) {
      const report = tuiViolations
        .map((violation) => formatTuiViolation("@lando/core", violation))
        .join("\n\n");
      throw new Error(`@lando/core must not load any TUI code path; offending import chains:\n\n${report}`);
    }
    expect(tuiViolations.length).toBe(0);
  });

  test.each(CRITICAL_ENTRY_POINTS)(
    "$specifier static module graph is OCLIF-free=$expectsOclif (compile-time graph assertion)",
    (entry: CriticalEntryPoint) => {
      const { specifier, expectsOclif } = entry;
      const entryAbs = resolveEntrySource(specifier);
      const { violations } = walkStaticImportGraph(entryAbs);

      if (expectsOclif) {
        expect(violations.length).toBeGreaterThan(0);
        return;
      }

      if (violations.length > 0) {
        const report = violations.map((violation) => formatViolation(specifier, violation)).join("\n\n");
        throw new Error(
          `${specifier} must not load any OCLIF code path; offending import chains:\n\n${report}`,
        );
      }
      expect(violations.length).toBe(0);
    },
  );

  test("failure messages name the full offending import chain", () => {
    const entryAbs = resolveEntrySource("@lando/core/oclif");
    const { violations } = walkStaticImportGraph(entryAbs);
    const firstViolation = violations[0];
    if (firstViolation === undefined) throw new Error("expected a positive-control violation");

    const message = formatViolation("@lando/core/oclif", firstViolation);
    expect(message).toContain("@lando/core/oclif");
    expect(message).toContain("→");
    expect(message).toContain("cli/oclif/index.ts");
    expect(firstViolation.chain.at(-1)).toMatch(/@oclif\/|cli\/oclif/);
  });
});

describe("Effect-free @lando/core/paths", () => {
  test("the walker detects Effect when present (positive control on @lando/core)", () => {
    const entryAbs = resolveEntrySource("@lando/core");
    const { effectViolations } = walkStaticImportGraph(entryAbs);
    expect(effectViolations.length).toBeGreaterThan(0);
  });

  test("@lando/core/paths has an Effect-free and OCLIF-free transitive static import graph", () => {
    const entryAbs = resolveEntrySource("@lando/core/paths");
    const { visited, violations, effectViolations } = walkStaticImportGraph(entryAbs);

    expect(visited.size).toBeGreaterThan(1);

    if (effectViolations.length > 0) {
      const report = effectViolations
        .map((violation) => formatEffectViolation("@lando/core/paths", violation))
        .join("\n\n");
      throw new Error(
        `@lando/core/paths must not load the Effect runtime; offending import chains:\n\n${report}`,
      );
    }
    if (violations.length > 0) {
      const report = violations
        .map((violation) => formatViolation("@lando/core/paths", violation))
        .join("\n\n");
      throw new Error(
        `@lando/core/paths must not load any OCLIF code path; offending import chains:\n\n${report}`,
      );
    }
    expect(effectViolations.length).toBe(0);
    expect(violations.length).toBe(0);
  });
});

describe("dynamic-import and re-export escape hatches", () => {
  const makeFixtureDir = async (): Promise<string> =>
    (await import("node:fs/promises")).mkdtemp(resolve(tmpdir(), "lando-import-boundary-"));

  const writeFixture = async (dir: string, name: string, content: string): Promise<string> => {
    const file = resolve(dir, name);
    await (await import("node:fs/promises")).writeFile(file, content, "utf8");
    return file;
  };

  const removeFixture = async (dir: string): Promise<void> =>
    (await import("node:fs/promises")).rm(dir, { recursive: true, force: true });

  test("the static scanner surfaces barrel re-exports so the walker flags them like direct imports", async () => {
    const dir = await makeFixtureDir();
    try {
      const star = await writeFixture(dir, "star.ts", 'export * from "@oclif/core";\n');
      const named = await writeFixture(dir, "named.ts", 'export { Command } from "@oclif/core";\n');

      const starWalk = walkStaticImportGraph(star);
      expect(starWalk.violations.length).toBe(1);
      expect(starWalk.violations[0]?.reason).toContain("@oclif/core");

      const namedWalk = walkStaticImportGraph(named);
      expect(namedWalk.violations.length).toBe(1);
      expect(namedWalk.violations[0]?.reason).toContain("@oclif/core");
    } finally {
      await removeFixture(dir);
    }
  });

  test("the lazy walker flags a dynamic import of a banned npm package", async () => {
    const dir = await makeFixtureDir();
    try {
      const entry = await writeFixture(
        dir,
        "dynamic-oclif.ts",
        'export const load = async (): Promise<unknown> => import("@oclif/core");\n',
      );

      const { dynamicViolations } = walkLazyModuleGraph(entry);
      expect(dynamicViolations.length).toBe(1);
      expect(dynamicViolations[0]?.family).toBe("oclif");
      expect(dynamicViolations[0]?.reason).toContain("@oclif/core");
    } finally {
      await removeFixture(dir);
    }
  });

  test("the lazy walker flags dynamic edges with whitespace or a line break before the paren", async () => {
    const dir = await makeFixtureDir();
    try {
      const spacedImport = await writeFixture(
        dir,
        "spaced-import.ts",
        'export const load = async (): Promise<unknown> => import ("@oclif/core");\n',
      );
      const newlineImport = await writeFixture(
        dir,
        "newline-import.ts",
        'export const load = async (): Promise<unknown> =>\n  import\n  ("@opentui/core");\n',
      );
      const spacedRequire = await writeFixture(dir, "spaced-require.ts", 'require ("effect");\n');

      const spacedImportWalk = walkLazyModuleGraph(spacedImport);
      expect(spacedImportWalk.dynamicViolations.length).toBe(1);
      expect(spacedImportWalk.dynamicViolations[0]?.family).toBe("oclif");

      const newlineImportWalk = walkLazyModuleGraph(newlineImport);
      expect(newlineImportWalk.dynamicViolations.length).toBe(1);
      expect(newlineImportWalk.dynamicViolations[0]?.family).toBe("tui");

      const spacedRequireWalk = walkLazyModuleGraph(spacedRequire);
      expect(spacedRequireWalk.dynamicViolations.length).toBe(1);
      expect(spacedRequireWalk.dynamicViolations[0]?.family).toBe("effect");
    } finally {
      await removeFixture(dir);
    }
  });

  test("the lazy walker resolves constructed dynamic specifiers through same-file consts", async () => {
    const dir = await makeFixtureDir();
    try {
      const entry = await writeFixture(
        dir,
        "constructed-tui.ts",
        [
          'const tuiSpecifier = "@opentui/" + "core";',
          "export const load = async (): Promise<unknown> => import(tuiSpecifier);",
          "",
        ].join("\n"),
      );

      const { dynamicViolations } = walkLazyModuleGraph(entry);
      expect(dynamicViolations.length).toBe(1);
      expect(dynamicViolations[0]?.family).toBe("tui");
      expect(dynamicViolations[0]?.reason).toContain("@opentui/core");
    } finally {
      await removeFixture(dir);
    }
  });

  test("a later function-scoped const shadow does not hide a banned module-scope dynamic specifier", async () => {
    const dir = await makeFixtureDir();
    try {
      const entry = await writeFixture(
        dir,
        "shadowed-function.ts",
        [
          'const mod = "@oclif/" + "core";',
          "export const load = async (): Promise<unknown> => import(mod);",
          "export const decoy = (): string => {",
          '  const mod = "./safe-local.ts";',
          "  return mod;",
          "};",
          "",
        ].join("\n"),
      );

      const { dynamicViolations } = walkLazyModuleGraph(entry);
      expect(dynamicViolations.length).toBe(1);
      expect(dynamicViolations[0]?.family).toBe("oclif");
      expect(dynamicViolations[0]?.reason).toContain("@oclif/core");
    } finally {
      await removeFixture(dir);
    }
  });

  test("a later block-scoped const shadow does not hide a banned module-scope dynamic specifier", async () => {
    const dir = await makeFixtureDir();
    try {
      const entry = await writeFixture(
        dir,
        "shadowed-block.ts",
        [
          'const tuiSpecifier = "@opentui/core";',
          "export const load = async (): Promise<unknown> => import(tuiSpecifier);",
          "if (Math.random() > 1) {",
          '  const tuiSpecifier = "./harmless.ts";',
          "  void tuiSpecifier;",
          "}",
          "",
        ].join("\n"),
      );

      const { dynamicViolations } = walkLazyModuleGraph(entry);
      expect(dynamicViolations.length).toBe(1);
      expect(dynamicViolations[0]?.family).toBe("tui");
      expect(dynamicViolations[0]?.reason).toContain("@opentui/core");
    } finally {
      await removeFixture(dir);
    }
  });

  test("an inner-scope dynamic import resolves the nearest lexical const, not the module-scope one", async () => {
    const dir = await makeFixtureDir();
    try {
      const entry = await writeFixture(
        dir,
        "inner-shadow-use.ts",
        [
          'const mod = "./harmless.ts";',
          "export const load = async (): Promise<unknown> => {",
          '  const mod = "@oclif/core";',
          "  return import(mod);",
          "};",
          "",
        ].join("\n"),
      );

      const { dynamicViolations } = walkLazyModuleGraph(entry);
      expect(dynamicViolations.length).toBe(1);
      expect(dynamicViolations[0]?.family).toBe("oclif");
      expect(dynamicViolations[0]?.reason).toContain("@oclif/core");
    } finally {
      await removeFixture(dir);
    }
  });

  test("the lazy walker ignores runtime-computed dynamic specifiers", async () => {
    const dir = await makeFixtureDir();
    try {
      const entry = await writeFixture(
        dir,
        "runtime-path.ts",
        "export const load = async (path: string): Promise<unknown> => import(`${path}?t=${Date.now()}`);\n",
      );

      const { dynamicViolations } = walkLazyModuleGraph(entry);
      expect(dynamicViolations.length).toBe(0);
    } finally {
      await removeFixture(dir);
    }
  });

  test.each(CRITICAL_ENTRY_POINTS)(
    "$specifier lazy module closure has no non-allowlisted banned dynamic imports",
    (entry: CriticalEntryPoint) => {
      const entryAbs = resolveEntrySource(entry.specifier);
      const { dynamicViolations } = walkLazyModuleGraph(entryAbs);

      const relevant = dynamicViolations.filter(
        (violation) => violation.family !== "effect" || entry.specifier === "@lando/core/paths",
      );
      if (relevant.length > 0) {
        const report = relevant
          .map((violation) => `${repoRelative(violation.importerAbs)} ${violation.reason}`)
          .join("\n");
        throw new Error(`${entry.specifier} lazy closure has banned dynamic imports:\n${report}`);
      }
      expect(relevant.length).toBe(0);
    },
  );

  test("the OpenTUI constructed-specifier boundary is detected AND allowlisted (allowlist stays load-bearing)", () => {
    const entryAbs = resolveEntrySource("@lando/core/cli");
    const { allowlistedDynamicEdges } = walkLazyModuleGraph(entryAbs);

    const promptDriverHit = allowlistedDynamicEdges.find(
      (edge) =>
        repoRelative(edge.importerAbs) === "plugins/renderer-lando/src/opentui/prompt-driver.ts" &&
        edge.specifier === "@opentui/core",
    );
    expect(promptDriverHit).toBeDefined();
    expect(promptDriverHit?.family).toBe("tui");
  });
});

describe("@lando/core default-entry symbol resolution", () => {
  test("resolves every exported symbol and asserts each is defined", async () => {
    const mod = (await import("@lando/core")) as Record<string, unknown>;
    const exportedKeys = Object.keys(mod).filter((key) => key !== "default");

    expect(exportedKeys.length).toBeGreaterThan(0);
    for (const key of exportedKeys) {
      expect(mod[key], `@lando/core export "${key}" must be defined`).toBeDefined();
    }

    // Known value exports per core/src/index.ts (factory + re-exported service tags).
    const requiredSymbols = [
      "makeLandoRuntime",
      "resolveApp",
      "openLandoRuntime",
      "AppResolveError",
      "AppPlanner",
      "CacheService",
      "CommandRegistry",
      "ConfigService",
      "EventService",
      "FileSystem",
      "LandofileService",
      "Logger",
      "PluginRegistry",
      "PrivilegeService",
      "ProcessRunner",
      "Renderer",
      "RuntimeProvider",
      "RuntimeProviderRegistry",
      "Telemetry",
    ] as const;
    for (const symbol of requiredSymbols) {
      expect(mod[symbol], `@lando/core must export "${symbol}"`).toBeDefined();
    }
    expect(mod.makeLandoRuntime).toBeFunction();
  });
});
