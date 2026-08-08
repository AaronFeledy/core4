import { describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative } from "node:path";

import { scanModuleEdges } from "../../../scripts/module-edge-scan.ts";

const repoRoot = realpathSync(join(import.meta.dir, "..", "..", ".."));

const readSource = (relativePath: string): string => readFileSync(join(repoRoot, relativePath), "utf8");

const collectTsFiles = (dir: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
};

type StaticImport = {
  readonly importer: string;
  readonly path: string;
  readonly resolved: string | undefined;
};

type StaticClosure = {
  readonly files: ReadonlySet<string>;
  readonly imports: ReadonlyArray<StaticImport>;
};

const isWithin = (root: string, path: string): boolean => {
  const fromRoot = relative(root, path);
  return fromRoot === "" || (!fromRoot.startsWith("..") && !isAbsolute(fromRoot));
};

const resolveFollowableImport = (path: string, importer: string, root: string): string | undefined => {
  if (path.startsWith("node:") || path.startsWith("bun:")) return undefined;
  try {
    const resolved = realpathSync(Bun.resolveSync(path, dirname(importer)));
    return isWithin(root, resolved) ? resolved : undefined;
  } catch (error) {
    if (error instanceof ResolveMessage) return undefined;
    throw error;
  }
};

const collectStaticClosure = (entry: string, traversalRoot: string): StaticClosure => {
  const root = realpathSync(traversalRoot);
  const pending = [realpathSync(entry)];
  const files = new Set<string>();
  const imports: StaticImport[] = [];
  while (pending.length > 0) {
    const importer = pending.shift();
    if (importer === undefined || files.has(importer)) continue;
    files.add(importer);
    const source = readFileSync(importer, "utf8");
    const edgePaths = scanModuleEdges(importer, source)
      .filter(
        (edge) =>
          !edge.typeOnly && (edge.kind === "import" || edge.kind === "re-export" || edge.kind === "require"),
      )
      .map((edge) => edge.specifier);
    for (const path of edgePaths) {
      const resolved = resolveFollowableImport(path, importer, root);
      imports.push({ importer, path, resolved });
      if (resolved !== undefined && !files.has(resolved)) pending.push(resolved);
    }
  }
  return { files, imports };
};

const bundledPluginPackages = new Set(
  readdirSync(join(repoRoot, "plugins")).map((directory) => `@lando/${directory}`),
);
const generatedCompositionRoots = [
  join(repoRoot, "core", "src", "plugins", "generated"),
  join(repoRoot, "core", "src", "runtime", "generated", "layers"),
] as const;
const forbiddenRuntimeImport = (path: string): boolean =>
  path === "effect" ||
  path.startsWith("effect/") ||
  path.startsWith("@effect/") ||
  path.startsWith("@oclif/") ||
  path.startsWith("@opentui/") ||
  path === "@lando/sdk" ||
  path.startsWith("@lando/sdk/") ||
  [...bundledPluginPackages].some(
    (packageName) => path === packageName || path.startsWith(`${packageName}/`),
  );

describe("OpenTUI cold-start canary", () => {
  test("the renderer plugin entry does not statically import OpenTUI or the prompt driver", () => {
    const index = readSource("plugins/renderer-lando/src/index.ts");
    expect(index).not.toMatch(/import\s[^;]*from\s+["']@opentui\/core["']/);
    expect(index).not.toMatch(/import\s[^;]*from\s+["']\.\/opentui\/prompt-driver/);
    // The driver must be reached through a dynamic import only.
    expect(index).toMatch(/await import\(["']\.\/opentui\/prompt-driver/);
  });

  test("production source has exactly one lazy literal OpenTUI import", async () => {
    const pluginSrcDirs = readdirSync(join(repoRoot, "plugins"))
      .map((entry) => join(repoRoot, "plugins", entry, "src"))
      .filter((path) => existsSync(path) && statSync(path).isDirectory());
    const productionDirs = [
      join(repoRoot, "core", "bin"),
      join(repoRoot, "core", "src"),
      join(repoRoot, "sdk", "src"),
      join(repoRoot, "container-runtime", "src"),
      ...pluginSrcDirs,
    ];
    const opentuiImports: Array<{ readonly file: string; readonly path: string; readonly kind: string }> = [];
    for (const file of productionDirs.flatMap(collectTsFiles)) {
      const source = readFileSync(file, "utf8");
      const imports = new Bun.Transpiler({ loader: "ts" }).scan(source);
      for (const edge of imports.imports) {
        if (edge.path.startsWith("@opentui/")) {
          opentuiImports.push({ file, path: edge.path, kind: edge.kind });
        }
      }
    }

    // Only the two renderer substrate modules may import @opentui/core, each via lazy dynamic import.
    for (const edge of opentuiImports) {
      expect(edge.path).toBe("@opentui/core");
      expect(edge.kind).toBe("dynamic-import");
    }
    const importingFiles = opentuiImports.map((edge) => edge.file).sort();
    expect(importingFiles).toEqual(
      [
        join(repoRoot, "plugins", "renderer-lando", "src", "opentui", "live-region-substrate.ts"),
        join(repoRoot, "plugins", "renderer-lando", "src", "opentui", "prompt-driver.ts"),
      ].sort(),
    );
  });

  test("renderer tests may statically import the OpenTUI testing harness", () => {
    const testDir = join(repoRoot, "plugins", "renderer-lando", "test");
    const testingImports = collectTsFiles(testDir).filter((file) =>
      /from\s+["']@opentui\/core\/testing["']/.test(readFileSync(file, "utf8")),
    );

    expect(testingImports.length).toBeGreaterThan(0);
  });

  test("the core driver loader reaches the renderer descriptor table without importing the plugin by name", () => {
    const loader = readSource("core/src/interaction/interactive-driver.ts");
    expect(loader).not.toMatch(/import\s[^;]*from\s+["']@lando\/renderer-lando["']/);
    expect(loader).not.toMatch(/import\(\s*["']@lando\/renderer-lando["']\s*\)/);
    expect(loader).not.toMatch(/^import\s[^;]*from\s+["']\.\.\/plugins\/generated\/renderers\.ts["']/m);
    expect(loader).toMatch(/import\(\s*["']\.\.\/plugins\/generated\/renderers(?:\.ts)?["']\s*\)/);
    expect(loader).not.toContain("@opentui/core");
    expect(loader).not.toMatch(/import\(\s*[A-Za-z_$][\w$]*\s*\)/);
  });

  test("the static closure scanner detects a planted transitive Effect import", () => {
    const fixtureRoot = mkdtempSync(join(tmpdir(), "lando-cold-closure-"));
    try {
      const entry = join(fixtureRoot, "entry.ts");
      const packageRoot = join(fixtureRoot, "node_modules", "eager-dependency");
      mkdirSync(packageRoot, { recursive: true });
      writeFileSync(
        entry,
        'import type { Erased } from "./types";\nimport "./middle";\nimport "eager-dependency";\nvoid import("./dynamic");\n',
      );
      writeFileSync(
        join(fixtureRoot, "middle.ts"),
        [
          'const effect = require ( "effect" );',
          '// require("comment-only")',
          'const lookalike = "require(\\"string-only\\")";',
          "void effect;",
          "void lookalike;",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(fixtureRoot, "types.ts"),
        'import { Effect } from "effect";\nexport type Erased = Effect;\n',
      );
      writeFileSync(join(fixtureRoot, "dynamic.ts"), 'import { Effect } from "effect";\nvoid Effect;\n');
      writeFileSync(join(packageRoot, "package.json"), '{"name":"eager-dependency","main":"index.js"}\n');
      writeFileSync(join(packageRoot, "index.js"), 'require("effect");\n');

      const closure = collectStaticClosure(entry, fixtureRoot);

      expect(closure.imports.filter((edge) => edge.path === "effect")).toHaveLength(2);
      expect(closure.imports.some((edge) => edge.path === "comment-only")).toBe(false);
      expect(closure.imports.some((edge) => edge.path === "string-only")).toBe(false);
      expect([...closure.files].sort()).toEqual(
        [entry, join(fixtureRoot, "middle.ts"), join(packageRoot, "index.js")].sort(),
      );
    } finally {
      rmSync(fixtureRoot, { recursive: true, force: true });
    }
  });

  test.each(["core/bin/lando.ts", "core/src/cli/index.ts"])(
    "%s keeps forbidden runtime families outside its static closure",
    (entry) => {
      const closure = collectStaticClosure(join(repoRoot, entry), repoRoot);
      const forbiddenImports = closure.imports.filter((edge) => forbiddenRuntimeImport(edge.path));
      const generatedCompositionImports = closure.imports.filter((edge) => {
        const resolved = edge.resolved;
        return resolved !== undefined && generatedCompositionRoots.some((root) => isWithin(root, resolved));
      });

      expect(closure.files.size).toBeGreaterThan(0);
      expect(forbiddenImports).toEqual([]);
      expect(generatedCompositionImports).toEqual([]);
    },
  );

  test("the binary entry static closure excludes the runtime dispatcher", () => {
    const closure = collectStaticClosure(join(repoRoot, "core", "bin", "lando.ts"), repoRoot);

    expect(closure.files.has(join(repoRoot, "core", "src", "cli", "run.ts"))).toBe(false);
  });
});
