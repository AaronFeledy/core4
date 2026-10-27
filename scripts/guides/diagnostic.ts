import { Schema } from "effect";
import type { GuideScenarioNode, GuideVariant, ParsedGuide } from "./model.ts";

export class GuidePropError extends Schema.TaggedError<GuidePropError>()("GuidePropError", {
  code: Schema.String,
  message: Schema.String,
  sourcePath: Schema.String,
  line: Schema.Number,
  column: Schema.Number,
  component: Schema.String,
  prop: Schema.String,
  issues: Schema.Array(Schema.Struct({ path: Schema.Array(Schema.Union([Schema.String, Schema.Number])) })),
  remediation: Schema.String,
}) {}

export class GuideSemanticError extends Schema.TaggedError<GuideSemanticError>()("GuideSemanticError", {
  code: Schema.String,
  message: Schema.String,
  sourcePath: Schema.String,
  line: Schema.Number,
  scenario: Schema.String,
  variant: Schema.String,
  component: Schema.String,
  prop: Schema.String,
  name: Schema.String,
  relatedDeclarationLine: Schema.optionalKey(Schema.Number),
  remediation: Schema.String,
}) {}

export class GuideRootError extends Schema.TaggedError<GuideRootError>()("GuideRootError", {
  code: Schema.Literal("guide.multiple-guides"),
  message: Schema.String,
  sourcePath: Schema.String,
  line: Schema.Number,
  relatedDeclarationLine: Schema.Number,
  component: Schema.Literal("Guide"),
  remediation: Schema.String,
}) {}

export const semanticError = (
  guide: ParsedGuide,
  scenario: GuideScenarioNode,
  detail: {
    readonly variant?: GuideVariant;
    readonly code: string;
    readonly line: number;
    readonly component: string;
    readonly prop: string;
    readonly name: string;
    readonly relatedDeclarationLine?: number;
  },
): never => {
  const { variant, ...fields } = detail;
  const variantLabel = variant?.pairs.map((pair) => `${pair.axis}=${pair.value}`).join(" ") ?? "";
  const corrections: Readonly<Record<string, string>> = {
    "guide.variable.missing": "Declare this binding on the selected scenario path before referencing it.",
    "guide.variable.hidden-reference":
      "Move the binding declaration to a public step or remove the public reference; a hidden display does not make a binding public.",
    "guide.variable.duplicate":
      "Keep one declaration for this name on each selected path; rename or remove the duplicate declaration.",
    "guide.variable.unused":
      "Remove this declaration or consume it in Run.command, Verify.command/file, or Inspect.file/json; opaque payloads do not consume bindings.",
    "guide.variable.invalid-name":
      "Use a simple token name starting with a letter, underscore or dollar sign, followed by letters, digits, underscores, dollar signs or hyphens.",
    "guide.runtime.mixed":
      "Split CLI/shell and library execution into separate scenarios, including hidden and cleanup steps.",
    "guide.runtime.e2e-library":
      "Use CLI execution for an e2e scenario or select the scenario layer for library execution.",
    "guide.tabs.missing-axis":
      "Declare tabs or axes in frontmatter and specify Tabs.axis when there is more than one axis.",
    "guide.tabs.unknown-axis": "Set Tabs.axis to an axis declared in frontmatter.",
    "guide.tabs.unknown-value": "Use a Tab.name declared on this axis in frontmatter.",
  };
  const related =
    detail.relatedDeclarationLine === undefined
      ? ""
      : ` Related declaration: ${guide.sourcePath}:${detail.relatedDeclarationLine}.`;
  throw new GuideSemanticError({
    ...fields,
    sourcePath: guide.sourcePath,
    scenario: scenario.id,
    variant: variantLabel,
    message: `${detail.code}: <${detail.component}> ${detail.prop} (${detail.name}) at ${guide.sourcePath}:${detail.line}, scenario ${scenario.id}, variant ${variantLabel || "default"}.${related}`,
    remediation: `${corrections[detail.code] ?? "Correct the conflicting names or variant declarations on this selected path."} Rerun bun run lint:guides and bun run codegen:guide-scenarios.`,
  });
};
