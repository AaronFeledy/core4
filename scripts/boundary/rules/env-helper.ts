import { dirname, join, relative, resolve } from "node:path";

import type { ModuleEdge } from "../../module-edge-scan.ts";
import type { BoundaryRule, FileContext } from "../types.ts";

const ENV_FEATURE_MODULE = "plugins/service-lando/src/features/env.ts";
const BLOCKED_NAMED_IMPORTS = new Set(["landoEnvFeature", "applyEnv"]);

const toRepoRelative = (root: string, file: string): string => relative(root, file).replaceAll("\\", "/");

const repoRootOf = (context: FileContext): string =>
  resolve(
    context.absolutePath,
    ...Array.from({ length: context.relativePath.split("/").length }, () => ".."),
  );

const resolveImportCandidates = (
  root: string,
  importer: string,
  specifier: string,
): ReadonlyArray<string> => {
  const base = specifier.startsWith(".") ? resolve(dirname(importer), specifier) : resolve(root, specifier);
  return [base, `${base}.ts`, join(base, "index.ts")];
};

const importsEnvFeatureModule = (root: string, importer: string, specifier: string): boolean =>
  resolveImportCandidates(root, importer, specifier).some(
    (candidate) => toRepoRelative(root, candidate) === ENV_FEATURE_MODULE,
  );

const hasBlockedName = (names: ReadonlyArray<string>): boolean =>
  names.some((name) => BLOCKED_NAMED_IMPORTS.has(name));

const isViolation = (root: string, importer: string, edge: ModuleEdge): boolean => {
  const reachesEnvModule = importsEnvFeatureModule(root, importer, edge.specifier);
  const pullsBlockedName =
    (edge.kind === "import" || edge.kind === "re-export") && hasBlockedName(edge.names);
  return reachesEnvModule || pullsBlockedName;
};

export const envHelperRule = {
  id: "env-helper",
  scope: {
    roots: ["plugins/service-lando/src/services"],
    extensions: [".ts"],
    excludeTestFiles: true,
  },
  carveOuts: { files: [], prefixes: [] },
  passMessage: "Env helper boundary check passed.",
  failureHeadline:
    "Env helper boundary check failed. Service files must not import lando.env helpers directly.",
  onEdges: (edges, context) => {
    // Every module edge counts: static imports, statically resolvable dynamic
    // `import()` / `require()` calls, and barrel re-exports. Reaching the env
    // feature module through any of them — or pulling a blocked helper name
    // through an import/re-export from any module — is a boundary violation.
    const root = repoRootOf(context);
    for (const edge of edges) {
      if (isViolation(root, context.absolutePath, edge)) {
        context.report({ line: edge.line, detail: edge.specifier });
      }
    }
  },
} satisfies BoundaryRule;
