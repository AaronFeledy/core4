import { Result } from "effect";
import { guideCommandArgv } from "../../core/src/docs/guide-compiler/command-argv.ts";
import { type GuideLintDiagnostic, diagnostic } from "./lint-diagnostic.ts";
import type { MdxNode } from "./mdx.ts";
import type { GuideScenarioAst } from "./model.ts";

export interface InstallLintDocument {
  readonly sourcePath: string;
  readonly root: MdxNode;
  readonly guide?: GuideScenarioAst;
}

/** A Composer package token, without its optional inline version constraint. */
const packageName = (token: string): string => {
  const separator = token.indexOf(":");
  return separator === -1 ? token : token.slice(0, separator);
};

const installKey = (argv: readonly string[]): string | undefined => {
  if (argv[0] !== "lando") return undefined;
  const subcommand = argv[1];
  if (subcommand?.endsWith("-scaffold")) return `lando ${subcommand}`;
  const prefix =
    subcommand === "create-project"
      ? ["lando", "create-project"]
      : subcommand === "composer" && argv[2] === "create-project"
        ? ["lando", "composer", "create-project"]
        : undefined;
  if (prefix === undefined) return undefined;
  const pkg = argv.slice(prefix.length).find((arg) => !arg.startsWith("-"));
  return pkg === undefined ? undefined : `${prefix.join(" ")} ${packageName(pkg)}`;
};

export const lintInstallCoverage = (
  documents: readonly InstallLintDocument[],
): readonly GuideLintDiagnostic[] => {
  const covered = new Set<string>();
  for (const { guide } of documents) {
    if (guide === undefined) continue;
    const e2eScenarios = new Set(
      guide.scenarios
        .filter((scenario) => (scenario.layer ?? guide.frontmatter.defaultLayer) === "e2e")
        .map((scenario) => scenario.id),
    );
    for (const { scenarioId, resolved } of guide.cells) {
      if (!e2eScenarios.has(scenarioId) || resolved.variant?.skip !== undefined || resolved.skipOnly)
        continue;
      for (const step of resolved.steps)
        for (const component of step.components) {
          // Resolved argv already expands Variable.value, unquotes words, and excludes skipped steps.
          if (component.kind !== "Run" && component.kind !== "Verify") continue;
          const key = installKey(component.argv ?? []);
          if (key !== undefined) covered.add(key);
        }
    }
  }

  const diagnostics: GuideLintDiagnostic[] = [];
  const languages = new Set(["sh", "bash", "shell", "console"]);
  for (const { sourcePath, root } of documents) {
    const visit = (node: MdxNode): void => {
      if (node.name === "Guide") return;
      if (node.type === "code" && languages.has(node.lang ?? "") && typeof node.value === "string") {
        for (const line of node.value.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
          if (!/^\s*lando\s/.test(line)) continue;
          const argv = guideCommandArgv(line);
          if (Result.isFailure(argv)) continue;
          const key = installKey(argv.success);
          if (key === undefined || covered.has(key)) continue;
          diagnostics.push(
            diagnostic(
              sourcePath,
              node,
              "guide.install.e2e-coverage",
              `App install ${key} has no live e2e coverage. Add a layer="e2e" scenario that runs it (cleanup required), or point readers at a guide whose e2e scenario does.`,
            ),
          );
        }
      }
      for (const child of node.children ?? []) visit(child);
    };
    visit(root);
  }
  return diagnostics;
};
