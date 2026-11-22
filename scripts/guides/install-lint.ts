import { Result } from "effect";
import { guideCommandArgv } from "../../core/src/docs/guide-compiler/command-argv.ts";
import { type CoverageLintDocument, e2eCommandArgvs } from "./coverage-lint-input.ts";
import { type GuideLintDiagnostic, diagnostic } from "./lint-diagnostic.ts";
import type { MdxNode } from "./mdx.ts";

/** A Composer package token, without its optional inline version constraint. */
const packageName = (token: string): string => {
  const separator = token.indexOf(":");
  return separator === -1 ? token : token.slice(0, separator);
};

const installKey = (argv: readonly string[]): string | undefined => {
  if (argv[0] !== "lando") return undefined;
  const subcommand = argv[1];
  if (subcommand?.endsWith("-scaffold")) return `lando ${subcommand}`;
  if (subcommand !== "create-project" && !(subcommand === "composer" && argv[2] === "create-project"))
    return undefined;
  const prefixLength = subcommand === "create-project" ? 2 : 3;
  const pkg = argv.slice(prefixLength).find((arg) => !arg.startsWith("-"));
  return pkg === undefined ? undefined : `${argv.slice(0, prefixLength).join(" ")} ${packageName(pkg)}`;
};

export const lintInstallCoverage = (
  documents: readonly CoverageLintDocument[],
): readonly GuideLintDiagnostic[] => {
  const covered = new Set<string>();
  for (const { guide } of documents) {
    if (guide === undefined) continue;
    for (const argv of e2eCommandArgvs(guide)) {
      const key = installKey(argv);
      if (key !== undefined) covered.add(key);
    }
  }

  const diagnostics: GuideLintDiagnostic[] = [];
  const languages = new Set(["sh", "bash", "shell", "console"]);
  for (const { sourcePath, root } of documents) {
    const visit = (node: MdxNode): void => {
      if (node.name === "Guide") return;
      if (node.type === "code" && languages.has(node.lang ?? "") && typeof node.value === "string") {
        for (const raw of node.value.replace(/\\\r?\n/g, "").split(/\r?\n/)) {
          const line = raw.replace(/^\s*\$ /, "");
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
