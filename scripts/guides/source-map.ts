import type { GuideLintDiagnostic } from "./lint-diagnostic.ts";
import type { GuideScenarioNode, GuideStepNode } from "./model.ts";

const allowedPublicLines = (scenario: GuideScenarioNode): ReadonlySet<number> => {
  const allowed = new Set<number>([scenario.line]);
  const add = (step: GuideStepNode): void => {
    if (step.hidden) return;
    allowed.add(step.line);
    for (const component of step.components)
      if (component.kind !== "Variable" && component.kind !== "UseFixture") allowed.add(component.line);
  };
  for (const item of scenario.body) {
    switch (item.kind) {
      case "step":
        add(item.step);
        break;
      case "tabs":
        allowed.add(item.line);
        for (const tab of item.tabs) {
          allowed.add(tab.line);
          for (const step of tab.steps) add(step);
        }
        break;
      case "skip":
      case "hidden":
        break;
    }
  }
  return allowed;
};
export const checkTranscriptFrameDiscipline = (
  scenario: GuideScenarioNode,
  frames: ReadonlyArray<{ readonly kind: string; readonly sourceFile: string; readonly sourceLine: number }>,
  sourcePath: string,
): ReadonlyArray<GuideLintDiagnostic> => {
  const allowed = allowedPublicLines(scenario);
  return frames
    .filter(
      (frame) => frame.sourceFile !== sourcePath || frame.sourceLine <= 0 || !allowed.has(frame.sourceLine),
    )
    .map((frame) => ({
      sourcePath,
      line: frame.sourceLine > 0 ? frame.sourceLine : scenario.line,
      column: 1,
      code: "guide.transcript.leak",
      message: `Public transcript frame (${frame.kind}) at line ${frame.sourceLine} does not map to a visible scenario component; hidden steps, fixtures, and variables must be excluded.`,
    }));
};
const parseSourceHeader = (line: string): { readonly path: string; readonly line: number } | undefined => {
  const match = /^\/\/ @source: (.+):(\d+)$/.exec(line.trim());
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[2] ?? "", 10);
  return Number.isInteger(parsed) && parsed > 0 ? { path: match[1] ?? "", line: parsed } : undefined;
};
const generatorAnnotationLines = (source: string): ReadonlyArray<string> => {
  const out: string[] = [];
  let libraryEmbedDepth = 0;
  for (const raw of source.split("\n")) {
    const trimmed = raw.trim();
    if (trimmed === "void LandoCore;" || trimmed === "void LandoTesting;") {
      libraryEmbedDepth = 1;
      continue;
    }
    if (libraryEmbedDepth > 0) {
      for (const ch of trimmed) {
        if (ch === "{") libraryEmbedDepth += 1;
        if (ch === "}") libraryEmbedDepth -= 1;
      }
      if (libraryEmbedDepth <= 0) libraryEmbedDepth = 0;
      continue;
    }
    out.push(trimmed);
  }
  return out;
};
export const checkScenarioSourceMap = (
  generatedSource: string,
  sourcePath: string,
  anchorLine: number,
): ReadonlyArray<GuideLintDiagnostic> => {
  const diagnostics: GuideLintDiagnostic[] = [];
  const push = (message: string): void => {
    diagnostics.push({
      sourcePath,
      line: anchorLine,
      column: 1,
      code: "guide.transcript.source-map",
      message,
    });
  };
  const lines = generatorAnnotationLines(generatedSource);
  if (!lines.includes("// @generated"))
    push("Generated scenario block is missing its `// @generated` header.");
  const headers = lines.map(parseSourceHeader).filter((header) => header !== undefined);
  if (headers.length === 0)
    push(`Generated scenario block is missing a \`// @source: ${sourcePath}:<line>\` header.`);
  else {
    if (headers.some((header) => header.path !== sourcePath))
      push(`Generated scenario block has a \`// @source:\` header that does not point at ${sourcePath}.`);
    if (!headers.some((header) => header.path === sourcePath && header.line === anchorLine))
      push(
        `Generated scenario block is missing a \`// @source: ${sourcePath}:${anchorLine}\` header anchoring the scenario.`,
      );
  }
  if (!lines.some((line) => line.startsWith("// @scenario: ") && line.length > "// @scenario: ".length))
    push("Generated scenario block is missing its `// @scenario:` header.");
  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index]?.startsWith("// @step:")) continue;
    const preceding = parseSourceHeader(lines[index - 1] ?? "");
    if (preceding === undefined || preceding.path !== sourcePath)
      push("A generated step is missing its preceding `// @source:` annotation.");
  }
  return diagnostics;
};
