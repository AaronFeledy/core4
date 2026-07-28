import { dirname, join, relative, resolve } from "node:path";

import type { ModuleEdge } from "../../module-edge-scan.ts";
import type { Diagnostic, InventoryFile, Rule } from "../types.ts";

const ENV_FEATURE_MODULE = "plugins/service-lando/src/features/env.ts";
const BLOCKED_NAMED_IMPORTS = new Set(["landoEnvFeature", "applyEnv"]);

const toRepoRelative = (root: string, file: string): string => relative(root, file).replaceAll("\\", "/");

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

const scanFile = (
  root: string,
  file: InventoryFile,
  edges: ReadonlyArray<ModuleEdge>,
): ReadonlyArray<Diagnostic> =>
  edges.flatMap((edge) => {
    const reachesEnvModule = importsEnvFeatureModule(root, file.absolutePath, edge.specifier);
    const pullsBlockedName =
      (edge.kind === "import" || edge.kind === "re-export") && hasBlockedName(edge.names);
    return reachesEnvModule || pullsBlockedName
      ? [
          {
            ruleId: "env-helper-boundary",
            file: file.relativePath,
            line: edge.line,
            message: edge.specifier,
          },
        ]
      : [];
  });

export const envHelperBoundaryRule: Rule = {
  id: "env-helper-boundary",
  title: "Env helper boundary",
  failureHeadline:
    "Env helper boundary check failed. Service files must not import lando.env helpers directly.",
  async run(context) {
    const files = await context.files("service-lando-services");
    return (
      await Promise.all(
        files.map(async (file) => scanFile(context.root, file, await context.moduleEdges(file))),
      )
    )
      .flat()
      .sort(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          (left.line ?? 0) - (right.line ?? 0) ||
          left.message.localeCompare(right.message),
      );
  },
};
