import { readFileSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

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

const firstPartySourceRoots = [`${coreSrc}/`, `${sdkSrc}/`, `${pluginsRoot}/`] as const;

const isFirstPartySource = (absPath: string): boolean =>
  firstPartySourceRoots.some((root) => absPath.startsWith(root));

const isOclifNpmSpecifier = (specifier: string): boolean =>
  specifier === "@oclif/core" || specifier.startsWith("@oclif/");

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

interface OclifViolation {
  /** Import chain from the walked entry to the offending module/specifier. */
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
 * Walk the transitive STATIC import graph rooted at `entryAbs`, following only
 * first-party edges, and collect every edge that crosses the OCLIF boundary.
 * Each violation carries the full import chain so failure messages can name the
 * offending path.
 */
const walkStaticImportGraph = (
  entryAbs: string,
): { readonly visited: ReadonlySet<string>; readonly violations: ReadonlyArray<OclifViolation> } => {
  const visited = new Set<string>();
  const violations: OclifViolation[] = [];

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

      if (resolvedAbs !== undefined && isFirstPartySource(resolvedAbs)) {
        visit(resolvedAbs, [...chain, absPath]);
      }
    }
  };

  visit(realpathSync(entryAbs), []);
  return { visited, violations };
};

const formatViolation = (entrySpecifier: string, violation: OclifViolation): string => {
  const chain = violation.chain.map(repoRelative).join("\n      → ");
  return `${entrySpecifier} ${violation.reason} via:\n      ${chain}`;
};

const resolveEntrySource = (specifier: string): string => realpathSync(Bun.resolveSync(specifier, repoRoot));

interface CriticalEntryPoint {
  readonly specifier: string;
  readonly label: string;
  readonly expectsOclif: boolean;
}

const CRITICAL_ENTRY_POINTS: CriticalEntryPoint[] = [
  { specifier: "@lando/core", label: "default", expectsOclif: false },
  { specifier: "@lando/core/cli", label: "/cli", expectsOclif: false },
  { specifier: "@lando/core/testing", label: "/testing", expectsOclif: false },
  { specifier: "@lando/core/oclif", label: "/oclif", expectsOclif: true },
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

  test("can import @lando/core/schema standalone", async () => {
    const mod = await import("../../src/schema/index.ts");
    expect(mod.GlobalConfig).toBeDefined();
    expect(mod.LandofileShape).toBeDefined();
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

  test("marks the Alpha library API as unstable/dev-channel only", async () => {
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

describe("OCLIF-free default entry", () => {
  test("the walker detects OCLIF when present (positive control on @lando/core/oclif)", () => {
    const entryAbs = resolveEntrySource("@lando/core/oclif");
    const { violations } = walkStaticImportGraph(entryAbs);

    // If the detector were a no-op, this would be empty and the suite would not
    // be guarding anything. The /oclif entry MUST reach the OCLIF code path.
    expect(violations.length).toBeGreaterThan(0);

    const namesOclif = violations.some((violation) =>
      violation.chain.some((link) => link.startsWith("@oclif/") || repoRelative(link).includes("cli/oclif")),
    );
    expect(namesOclif).toBe(true);
  });

  test("the default @lando/core entry has an OCLIF-free transitive static import graph", () => {
    const entryAbs = resolveEntrySource("@lando/core");
    const { visited, violations } = walkStaticImportGraph(entryAbs);

    // Sanity: the default entry pulls in a non-trivial runtime graph, so a "0
    // visited / 0 violations" pass cannot be a silently broken walk.
    expect(visited.size).toBeGreaterThan(1);

    if (violations.length > 0) {
      const report = violations.map((violation) => formatViolation("@lando/core", violation)).join("\n\n");
      throw new Error(`@lando/core must not load any OCLIF code path; offending import chains:\n\n${report}`);
    }
    expect(violations.length).toBe(0);
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
    // Names the entry, joins the chain with arrows, and ends at the OCLIF offender.
    expect(message).toContain("@lando/core/oclif");
    expect(message).toContain("→");
    expect(message).toContain("cli/oclif/index.ts");
    expect(firstViolation.chain.at(-1)).toMatch(/@oclif\/|cli\/oclif/);
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
