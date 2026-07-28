import type { ArchitectureRuleId, Diagnostic, Rule, RunResult } from "./types.ts";

export const formatDiagnostic = (diagnostic: Diagnostic): string =>
  diagnostic.line === undefined
    ? `${diagnostic.file}: ${diagnostic.message}`
    : `${diagnostic.file}:${diagnostic.line}: ${diagnostic.message}`;

const ruleById = (rules: ReadonlyArray<Rule>): ReadonlyMap<ArchitectureRuleId, Rule> =>
  new Map(rules.map((rule) => [rule.id, rule]));

export const formatHumanReport = (result: RunResult, rules: ReadonlyArray<Rule>): string => {
  if (result.ok) return `Architecture checks passed. Files scanned: ${result.filesScanned}\n`;
  const knownRules = ruleById(rules);
  const sections: string[] = [];
  for (const [ruleId, diagnostics] of result.byRule) {
    if (diagnostics.length === 0) continue;
    const headline = knownRules.get(ruleId)?.failureHeadline ?? `${ruleId} failed.`;
    sections.push([headline, ...diagnostics.map(formatDiagnostic)].join("\n"));
  }
  if (result.staleExceptions.length > 0) {
    sections.push(
      ["Architecture exception audit failed.", ...result.staleExceptions.map(({ message }) => message)].join(
        "\n",
      ),
    );
  }
  return `${sections.join("\n\n")}\n`;
};

export const formatJsonReport = (result: RunResult): string =>
  `${JSON.stringify(
    {
      ok: result.ok,
      diagnostics: result.diagnostics,
      byRule: Object.fromEntries(result.byRule),
      staleExceptions: result.staleExceptions,
      filesScanned: result.filesScanned,
    },
    null,
    2,
  )}\n`;
