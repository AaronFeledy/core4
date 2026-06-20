import { readFileSync, realpathSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";

import { describe, expect, test } from "bun:test";

// Import-boundary assertion for the shared file-format codec module (§10.13).
// The codec module MUST stay pure and dependency-light: it constructs no
// `LandoRuntime`, reaches no Effect runtime service / bootstrap layer, and pulls
// no `@oclif/core`. This walks the codec's transitive STATIC import graph
// (following only first-party edges) and fails on any forbidden edge.

const repoRoot = resolve(import.meta.dirname, "../../..");
const coreSrc = resolve(repoRoot, "core/src");
const sdkSrc = resolve(repoRoot, "sdk/src");
const pluginsRoot = resolve(repoRoot, "plugins");

const codecEntry = resolve(coreSrc, "managed-file/codecs.ts");

/** Modules whose construction would mean the codec drags in a `LandoRuntime`. */
const runtimeCodePathDir = `${resolve(coreSrc, "runtime")}/`;
const coreDefaultEntry = resolve(coreSrc, "index.ts");
const oclifCodePathDir = `${resolve(coreSrc, "cli/oclif")}/`;

const firstPartySourceRoots = [`${coreSrc}/`, `${sdkSrc}/`, `${pluginsRoot}/`] as const;
const isFirstPartySource = (absPath: string): boolean =>
  firstPartySourceRoots.some((root) => absPath.startsWith(root));

const isOclifNpmSpecifier = (specifier: string): boolean =>
  specifier === "@oclif/core" || specifier.startsWith("@oclif/");

const isFollowableSpecifier = (specifier: string): boolean =>
  specifier.startsWith(".") || specifier.startsWith("@lando/");

const repoRelative = (absPathOrSpecifier: string): string =>
  absPathOrSpecifier.startsWith("/") ? relative(repoRoot, absPathOrSpecifier) : absPathOrSpecifier;

const transpiler = new Bun.Transpiler({ loader: "ts" });

const scanStaticImports = (source: string): ReadonlyArray<string> =>
  transpiler
    .scan(source)
    .imports.filter((entry) => entry.kind === "import-statement")
    .map((entry) => entry.path);

const resolveFirstParty = (specifier: string, importerAbs: string): string | undefined => {
  try {
    return realpathSync(Bun.resolveSync(specifier, dirname(importerAbs)));
  } catch {
    return undefined;
  }
};

interface Violation {
  readonly chain: ReadonlyArray<string>;
  readonly reason: string;
}

const classifyEdge = (edge: {
  readonly specifier: string;
  readonly resolvedAbs: string | undefined;
}): string | undefined => {
  if (isOclifNpmSpecifier(edge.specifier)) {
    return `imports the OCLIF npm package "${edge.specifier}"`;
  }
  if (edge.resolvedAbs === undefined) return undefined;
  if (edge.resolvedAbs.startsWith(runtimeCodePathDir)) {
    return `reaches the LandoRuntime layer code path ${repoRelative(edge.resolvedAbs)}`;
  }
  if (edge.resolvedAbs === coreDefaultEntry) {
    return `reaches the @lando/core default entry (makeLandoRuntime) ${repoRelative(edge.resolvedAbs)}`;
  }
  if (edge.resolvedAbs.startsWith(oclifCodePathDir)) {
    return `reaches the OCLIF code path ${repoRelative(edge.resolvedAbs)}`;
  }
  return undefined;
};

const walk = (
  entryAbs: string,
): { readonly visited: ReadonlySet<string>; readonly violations: ReadonlyArray<Violation> } => {
  const visited = new Set<string>();
  const violations: Violation[] = [];

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

    for (const specifier of scanStaticImports(source)) {
      const resolvedAbs = isOclifNpmSpecifier(specifier)
        ? undefined
        : isFollowableSpecifier(specifier)
          ? resolveFirstParty(specifier, absPath)
          : undefined;

      const reason = classifyEdge({ specifier, resolvedAbs });
      if (reason !== undefined) {
        violations.push({ chain: [...chain, absPath, resolvedAbs ?? specifier], reason });
      }

      if (resolvedAbs !== undefined && isFirstPartySource(resolvedAbs)) {
        visit(resolvedAbs, [...chain, absPath]);
      }
    }
  };

  visit(realpathSync(entryAbs), []);
  return { visited, violations };
};

describe("managed-file codec import boundary (constructs no LandoRuntime)", () => {
  test("the codec module's transitive static graph is runtime/OCLIF-free", () => {
    const { visited, violations } = walk(codecEntry);

    expect(visited.size).toBeGreaterThan(1);
    if (violations.length > 0) {
      const report = violations
        .map(
          (violation) =>
            `${violation.reason} via:\n      ${violation.chain.map(repoRelative).join("\n      → ")}`,
        )
        .join("\n\n");
      throw new Error(`core/src/managed-file/codecs.ts must construct no LandoRuntime:\n\n${report}`);
    }
    expect(violations.length).toBe(0);
  });

  test("the codec module's direct imports stay on the pure allowlist", () => {
    const source = readFileSync(codecEntry, "utf8");
    const directImports = scanStaticImports(source);

    const allowed = new Set(["effect", "@lando/sdk/landofile", "@lando/sdk/errors", "@lando/sdk/schema"]);
    for (const specifier of directImports) {
      expect(allowed.has(specifier), `unexpected codec import: "${specifier}"`).toBe(true);
    }
  });

  test("the detector flags a runtime edge (positive control)", () => {
    expect(
      classifyEdge({ specifier: "../runtime/layer.ts", resolvedAbs: resolve(coreSrc, "runtime/layer.ts") }),
    ).toContain("LandoRuntime");
    expect(classifyEdge({ specifier: "@oclif/core", resolvedAbs: undefined })).toContain("OCLIF");
    expect(classifyEdge({ specifier: "effect", resolvedAbs: undefined })).toBeUndefined();
  });

  test("importing the codec module has no construction side effects", async () => {
    const mod = await import("../../src/managed-file/codecs.ts");
    expect(mod.encode).toBeFunction();
    expect(mod.decode).toBeFunction();
    expect(mod.mergeManaged).toBeFunction();
  });
});
