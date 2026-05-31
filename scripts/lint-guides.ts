#!/usr/bin/env bun
import { dirname, resolve } from "node:path";

import { Effect, Either } from "effect";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseLandofile } from "../core/src/landofile/parser.ts";
import { decodeGuideFrontmatterEither } from "../sdk/src/docs/components/index.ts";
import {
  GuideFrontmatterValidationError,
  GuideHiddenScenarioReasonError,
  NotImplementedError,
} from "../sdk/src/errors/index.ts";
import { discoverGuideMdxFiles } from "./build-guide-scenarios.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");

const ALPHA_2_COMPONENTS = new Set([
  "Guide",
  "Scenario",
  "Step",
  "Run",
  "Verify",
  "Cleanup",
  "Variable",
  "UseFixture",
  "Inspect",
  "Tabs",
  "Tab",
  "Hidden",
  "Inline",
  "Skip",
]);

// This script enforces only the core guide rules implemented below.
// Other guide checks remain deferred to a later pass.

type MdxNode = {
  readonly type: string;
  readonly name?: string | null;
  readonly value?: unknown;
  readonly attributes?: ReadonlyArray<MdxAttribute>;
  readonly children?: ReadonlyArray<MdxNode>;
  readonly position?: { readonly start?: { readonly line?: number; readonly column?: number } };
};

type MdxAttribute = {
  readonly type: string;
  readonly name?: string;
  readonly value?:
    | string
    | null
    | { readonly type?: string; readonly value?: string; readonly data?: unknown };
};

export interface GuideLintDiagnostic {
  readonly sourcePath: string;
  readonly line: number;
  readonly column: number;
  readonly code: string;
  readonly message: string;
}

export interface GuideLintResult {
  readonly diagnostics: ReadonlyArray<GuideLintDiagnostic>;
}

const processor = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter, ["yaml"]);

const lineOf = (node: MdxNode): number => node.position?.start?.line ?? 1;
const columnOf = (node: MdxNode): number => node.position?.start?.column ?? 1;

const expressionToValue = (expression: string): unknown => {
  const trimmed = expression.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const jsonish = trimmed.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, '$1"$2"$3').replace(/'/g, '"');
    return JSON.parse(jsonish) as unknown;
  }
  throw new Error(`Unsupported MDX attribute expression: ${expression}`);
};

const propsOf = (node: MdxNode): Record<string, unknown> => {
  const props: Record<string, unknown> = {};
  for (const attribute of node.attributes ?? []) {
    if (attribute.type !== "mdxJsxAttribute" || attribute.name === undefined) continue;
    if (attribute.value === null || attribute.value === undefined) {
      props[attribute.name] = true;
    } else if (typeof attribute.value === "string") {
      props[attribute.name] = attribute.value;
    } else {
      props[attribute.name] = expressionToValue(attribute.value.value ?? "");
    }
  }
  return props;
};

const firstYaml = (
  root: MdxNode,
): { readonly value: string | undefined; readonly node: MdxNode | undefined } => {
  const node = root.children?.find((child) => child.type === "yaml");
  return { value: node?.value as string | undefined, node };
};

const parseFrontmatter = (sourcePath: string, yaml: string | undefined): Record<string, unknown> => {
  if (yaml === undefined) return {};
  const value = Effect.runSync(parseLandofile({ file: sourcePath, content: yaml, cwd: dirname(sourcePath) }));
  if (value === null || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
};

const elementChildren = (node: MdxNode): ReadonlyArray<MdxNode> =>
  (node.children ?? []).filter((child) => child.type === "mdxJsxFlowElement");

const walkElements = (node: MdxNode, visitor: (node: MdxNode) => void): void => {
  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") visitor(node);
  for (const child of node.children ?? []) walkElements(child, visitor);
};

const diagnostic = (
  sourcePath: string,
  node: MdxNode,
  code: string,
  message: string,
): GuideLintDiagnostic => ({
  sourcePath,
  line: lineOf(node),
  column: columnOf(node),
  code,
  message,
});

const formatErrorMessage = (error: unknown): string => {
  if (error instanceof NotImplementedError) return `${error.message} ${error.remediation}`;
  if (error instanceof GuideFrontmatterValidationError) return `${error.message} ${error.remediation}`;
  if (error instanceof GuideHiddenScenarioReasonError) return `${error.message} ${error.remediation}`;
  return error instanceof Error ? error.message : String(error);
};

const validateFrontmatter = (
  sourcePath: string,
  root: MdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): Record<string, unknown> => {
  const yaml = firstYaml(root);
  let frontmatter: Record<string, unknown>;
  try {
    frontmatter = parseFrontmatter(sourcePath, yaml.value);
  } catch (error) {
    diagnostics.push(
      diagnostic(
        sourcePath,
        yaml.node ?? root,
        "guide.frontmatter",
        `Invalid frontmatter: ${formatErrorMessage(error)}`,
      ),
    );
    return {};
  }

  const { diataxis: _diataxis, ...schemaFrontmatter } = frontmatter;
  const decoded = decodeGuideFrontmatterEither(schemaFrontmatter);
  if (Either.isLeft(decoded)) {
    diagnostics.push(
      diagnostic(
        sourcePath,
        yaml.node ?? root,
        "guide.frontmatter",
        `Invalid frontmatter: ${formatErrorMessage(decoded.left)}`,
      ),
    );
  }
  return frontmatter;
};

const lintScenarioIds = (
  sourcePath: string,
  guide: MdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): ReadonlyArray<MdxNode> => {
  const scenarios = elementChildren(guide).filter((child) => child.name === "Scenario");
  const seen = new Set<string>();
  for (const scenario of scenarios) {
    const id = propsOf(scenario).id;
    if (typeof id !== "string") continue;
    if (seen.has(id)) {
      diagnostics.push(
        diagnostic(sourcePath, scenario, "guide.scenario.duplicate-id", `Duplicate <Scenario id="${id}">.`),
      );
      continue;
    }
    seen.add(id);
  }
  return scenarios;
};

const lintHiddenScenarioReason = (
  sourcePath: string,
  scenarios: ReadonlyArray<MdxNode>,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  for (const scenario of scenarios) {
    const props = propsOf(scenario);
    if (props.render !== false) continue;
    if (typeof props.reason === "string" && props.reason.length >= 8) continue;
    diagnostics.push(
      diagnostic(
        sourcePath,
        scenario,
        "guide.scenario.hidden-reason",
        "<Scenario render={false}> requires a `reason` of at least 8 characters per §19.9.",
      ),
    );
  }
};

const lintHiddenReason = (
  sourcePath: string,
  root: MdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  walkElements(root, (node) => {
    if (node.name !== "Hidden") return;
    const reason = propsOf(node).reason;
    if (typeof reason === "string" && reason.length >= 8) return;
    diagnostics.push(
      diagnostic(
        sourcePath,
        node,
        "guide.hidden.reason",
        "<Hidden> requires a `reason` of at least 8 characters per §19.10.",
      ),
    );
  });
};

const lintSkipReason = (sourcePath: string, root: MdxNode, diagnostics: Array<GuideLintDiagnostic>): void => {
  walkElements(root, (node) => {
    if (node.name !== "Skip") return;
    const reason = propsOf(node).reason;
    if (typeof reason === "string" && reason.length >= 8) return;
    diagnostics.push(
      diagnostic(
        sourcePath,
        node,
        "guide.skip.reason",
        "<Skip> requires a `reason` of at least 8 characters per §19.10.",
      ),
    );
  });
};

const lintInlineJustification = (
  sourcePath: string,
  root: MdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  walkElements(root, (node) => {
    if (node.name !== "Inline") return;
    const justification = propsOf(node).justification;
    if (typeof justification === "string" && justification.length >= 8) return;
    diagnostics.push(
      diagnostic(
        sourcePath,
        node,
        "guide.inline.justification",
        "<Inline> requires a `justification` of at least 8 characters per §19.10.",
      ),
    );
  });
};

const unconditionalStepElements = (scenario: MdxNode): ReadonlyArray<MdxNode> =>
  elementChildren(scenario).flatMap((child) => {
    if (child.name === "Step") return [child];
    if (child.name === "Hidden")
      return elementChildren(child).filter((hiddenChild) => hiddenChild.name === "Step");
    return [];
  });

const lintStepNames = (
  sourcePath: string,
  scenarios: ReadonlyArray<MdxNode>,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  for (const scenario of scenarios) {
    const seen = new Set<string>();
    for (const step of unconditionalStepElements(scenario)) {
      const name = propsOf(step).name;
      if (typeof name !== "string") continue;
      if (seen.has(name)) {
        diagnostics.push(
          diagnostic(sourcePath, step, "guide.step.duplicate-name", `Duplicate <Step name="${name}">.`),
        );
        continue;
      }
      seen.add(name);
    }
  }
};

const lintComponents = (sourcePath: string, root: MdxNode, diagnostics: Array<GuideLintDiagnostic>): void => {
  walkElements(root, (node) => {
    if (node.name === undefined || node.name === null || ALPHA_2_COMPONENTS.has(node.name)) return;
    diagnostics.push(
      diagnostic(
        sourcePath,
        node,
        "guide.component.beta",
        `<${node.name}> is not supported in Alpha 2. <${node.name}> ships in Phase 3 Beta — see spec/ROADMAP.md.`,
      ),
    );
  });
};

const lintTabs = (
  sourcePath: string,
  root: MdxNode,
  frontmatter: Record<string, unknown>,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  const hasTabs = Object.hasOwn(frontmatter, "tabs");
  const hasAxes = Object.hasOwn(frontmatter, "axes");
  const stringValues = (input: unknown): ReadonlyArray<string> | undefined =>
    Array.isArray(input) ? input.filter((value): value is string => typeof value === "string") : undefined;
  const axesRecord =
    hasAxes &&
    frontmatter.axes !== null &&
    typeof frontmatter.axes === "object" &&
    !Array.isArray(frontmatter.axes)
      ? (frontmatter.axes as Record<string, unknown>)
      : {};
  const axisNames = Object.keys(axesRecord);
  const tabsValues = stringValues(frontmatter.tabs);

  walkElements(root, (node) => {
    if (node.name !== "Tabs") return;
    if (!hasTabs && !hasAxes) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.tabs.missing-axis",
          "<Tabs> requires a `tabs:` or `axes:` axis declaration in frontmatter.",
        ),
      );
      return;
    }
    const axisProp = propsOf(node).axis;
    let axisName: string | undefined;
    if (hasTabs) {
      axisName = "default";
    } else if (typeof axisProp === "string") {
      if (!axisNames.includes(axisProp)) {
        diagnostics.push(
          diagnostic(
            sourcePath,
            node,
            "guide.tabs.unknown-axis",
            `<Tabs axis="${axisProp}"> is not a declared \`axes:\` axis.`,
          ),
        );
        return;
      }
      axisName = axisProp;
    } else if (axisNames.length === 1) {
      axisName = axisNames[0];
    } else {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.tabs.missing-axis",
          "<Tabs> requires an `axis` attribute because this guide declares multiple axes.",
        ),
      );
      return;
    }
    const declaredValues = hasTabs ? tabsValues : stringValues(axesRecord[axisName ?? ""]);
    const seen = new Set<string>();
    for (const tab of elementChildren(node).filter((child) => child.name === "Tab")) {
      const name = propsOf(tab).name;
      if (typeof name !== "string") continue;
      if (seen.has(name)) {
        diagnostics.push(
          diagnostic(
            sourcePath,
            tab,
            "guide.tabs.duplicate-id",
            `Duplicate <Tab name="${name}"> within a <Tabs> block.`,
          ),
        );
        continue;
      }
      seen.add(name);
      if (declaredValues !== undefined && !declaredValues.includes(name)) {
        const reference = hasTabs ? "`tabs:` value" : `\`${axisName}\` axis value`;
        diagnostics.push(
          diagnostic(
            sourcePath,
            tab,
            "guide.tabs.missing-axis",
            `<Tab name="${name}"> is not a declared ${reference}.`,
          ),
        );
      }
    }
  });
};

const scenarioRenders = (scenario: MdxNode): boolean => propsOf(scenario).render !== false;

const lintDiataxis = (
  sourcePath: string,
  guide: MdxNode | undefined,
  frontmatter: Record<string, unknown>,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  if (!Object.hasOwn(frontmatter, "diataxis")) return;
  if (guide === undefined || !elementChildren(guide).some(scenarioRenders)) return;
  if (frontmatter.diataxis === "tutorial" || frontmatter.diataxis === "how-to") return;
  diagnostics.push(
    diagnostic(
      sourcePath,
      guide,
      "guide.diataxis",
      "`diataxis:` must be `tutorial` or `how-to` for guides containing rendered scenarios.",
    ),
  );
};

export const lintGuideContent = (sourcePath: string, content: string): GuideLintResult => {
  const diagnostics: Array<GuideLintDiagnostic> = [];
  const root = processor.parse(content) as MdxNode;
  const frontmatter = validateFrontmatter(sourcePath, root, diagnostics);
  const guide = elementChildren(root).find((child) => child.name === "Guide");
  lintComponents(sourcePath, root, diagnostics);
  const scenarios = guide === undefined ? [] : lintScenarioIds(sourcePath, guide, diagnostics);
  lintHiddenScenarioReason(sourcePath, scenarios, diagnostics);
  lintHiddenReason(sourcePath, root, diagnostics);
  lintSkipReason(sourcePath, root, diagnostics);
  lintInlineJustification(sourcePath, root, diagnostics);
  lintStepNames(sourcePath, scenarios, diagnostics);
  lintTabs(sourcePath, root, frontmatter, diagnostics);
  lintDiataxis(sourcePath, guide, frontmatter, diagnostics);
  return { diagnostics };
};

export const lintGuides = async (root = REPO_ROOT): Promise<GuideLintResult> => {
  const diagnostics: Array<GuideLintDiagnostic> = [];
  const files = await discoverGuideMdxFiles(root);
  for (const sourcePath of files) {
    const result = lintGuideContent(sourcePath, await Bun.file(resolve(root, sourcePath)).text());
    diagnostics.push(...result.diagnostics);
  }
  return { diagnostics };
};

export const formatGuideLintDiagnostic = (entry: GuideLintDiagnostic): string =>
  `${entry.sourcePath}:${entry.line}:${entry.column}: ${entry.code}: ${entry.message}`;

const main = async (): Promise<void> => {
  const result = await lintGuides(REPO_ROOT);
  if (result.diagnostics.length === 0) {
    process.stdout.write("Guide lint passed.\n");
    return;
  }
  process.stderr.write(`${result.diagnostics.map(formatGuideLintDiagnostic).join("\n")}\n`);
  process.exitCode = 1;
};

if (import.meta.main) await main();
