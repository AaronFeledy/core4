#!/usr/bin/env bun
import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";

import { Effect, Either } from "effect";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseLandofile } from "../core/src/landofile/parser.ts";
import {
  decodeCleanupPropsEither,
  decodeGuideFrontmatterEither,
  decodeInspectPropsEither,
  decodeRunPropsEither,
  decodeScenarioPropsEither,
  decodeStepPropsEither,
  decodeUseFixturePropsEither,
  decodeVariablePropsEither,
  decodeVerifyPropsEither,
} from "../sdk/src/docs/components/index.ts";
import type { GuidePlatform } from "../sdk/src/docs/guide-frontmatter.ts";
import {
  GuideFrontmatterValidationError,
  GuideHiddenScenarioReasonError,
  NotImplementedError,
} from "../sdk/src/errors/index.ts";
import {
  type GuideScenarioAst,
  type GuideScenarioNode,
  type GuideStepNode,
  buildPublicTranscript,
  discoverGuideMdxFiles,
  parseGuideScenarioAst,
  renderScenarioTest,
  resolveHostGuidePlatform,
  variantsOf,
} from "./build-guide-scenarios.ts";

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

type MdxNode = {
  readonly type: string;
  readonly name?: string | null;
  readonly value?: unknown;
  readonly lang?: string | null;
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

export interface GuideFixtureInventoryEntry {
  readonly name: string;
  readonly sourcePath: string;
  readonly scope: "local" | "shared";
  readonly kind: "directory" | "symlink" | "other";
  readonly symlinkPaths?: ReadonlyArray<string>;
}

export interface GuideLintContentOptions {
  readonly fixtures?: ReadonlyArray<GuideFixtureInventoryEntry>;
}

export interface GuideLintOptions {
  readonly guideRoot?: string;
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
  if (trimmed.startsWith("`") && trimmed.endsWith("`")) {
    const withoutEscapes = trimmed.replace(/\\./g, "");
    if (withoutEscapes.includes("${")) {
      throw new Error(
        "Template literal interpolation is not allowed in guide props; use a literal backtick string without `${...}`.",
      );
    }
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

const walkAllNodes = (node: MdxNode, visitor: (node: MdxNode) => void): void => {
  visitor(node);
  for (const child of node.children ?? []) walkAllNodes(child, visitor);
};

const SHELL_FENCE_LANGS = new Set(["bash", "sh", "zsh", "shell", "console"]);

const lintRawShellFences = (
  sourcePath: string,
  guide: MdxNode | undefined,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  if (guide === undefined) return;
  walkAllNodes(guide, (node) => {
    if (node.type !== "code") return;
    const lang = typeof node.lang === "string" ? node.lang.toLowerCase() : undefined;
    if (lang === undefined || !SHELL_FENCE_LANGS.has(lang)) return;
    diagnostics.push(
      diagnostic(
        sourcePath,
        node,
        "guide.shell-fence",
        `Raw fenced \`${node.lang}\` code block is not allowed inside <Guide>; use <Run> or <Inline>.`,
      ),
    );
  });
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
        "<Scenario render={false}> requires a `reason` of at least 8 characters.",
      ),
    );
  }
};

const lintScenarioProps = (
  sourcePath: string,
  scenarios: ReadonlyArray<MdxNode>,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  for (const scenario of scenarios) {
    const props = propsOf(scenario);
    if (!Object.hasOwn(props, "layer")) continue;
    const decoded = decodeScenarioPropsEither(props);
    if (Either.isRight(decoded)) continue;
    diagnostics.push(
      diagnostic(
        sourcePath,
        scenario,
        "guide.scenario.props",
        `<Scenario> props are invalid: ${formatErrorMessage(decoded.left)}`,
      ),
    );
  }
};

const hasCleanup = (node: MdxNode): boolean => {
  if (node.name === "Cleanup") return true;
  return (node.children ?? []).some(hasCleanup);
};

const lintE2eScenarios = (
  sourcePath: string,
  scenarios: ReadonlyArray<MdxNode>,
  frontmatter: Record<string, unknown>,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  for (const scenario of scenarios) {
    const props = propsOf(scenario);
    const layer = props.layer ?? frontmatter.defaultLayer ?? "scenario";
    if (layer !== "e2e") continue;
    if (!hasCleanup(scenario)) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          scenario,
          "guide.scenario.e2e-cleanup",
          '<Scenario layer="e2e"> requires at least one <Cleanup> step so provider resources are torn down.',
        ),
      );
    }
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
        "<Hidden> requires a `reason` of at least 8 characters.",
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
        "<Skip> requires a `reason` of at least 8 characters.",
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
        "<Inline> requires a `justification` of at least 8 characters.",
      ),
    );
  });
};

const unconditionalStepElements = (scenario: MdxNode): ReadonlyArray<MdxNode> =>
  elementChildren(scenario).flatMap((child) => {
    if (child.name === "Step") return [child];
    if (child.name === "Hidden" || child.name === "Skip")
      return elementChildren(child).filter((nestedChild) => nestedChild.name === "Step");
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

const lintVerifyMatchers = (
  sourcePath: string,
  root: MdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  walkElements(root, (node) => {
    if (node.name !== "Verify") return;
    let props: Record<string, unknown>;
    try {
      props = propsOf(node);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.verify.matcher",
          `Invalid <Verify> props: ${formatErrorMessage(error)}.`,
        ),
      );
      return;
    }
    const decoded = decodeVerifyPropsEither(props);
    if (Either.isLeft(decoded)) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.verify.matcher",
          `Invalid <Verify> props: ${formatErrorMessage(decoded.left)}.`,
        ),
      );
    }
  });
};

const lintRunBindings = (
  sourcePath: string,
  root: MdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  walkElements(root, (node) => {
    if (node.name !== "Run") return;
    let props: Record<string, unknown>;
    try {
      props = propsOf(node);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.run.binding",
          `Invalid <Run> props: ${formatErrorMessage(error)}.`,
        ),
      );
      return;
    }
    const decoded = decodeRunPropsEither(props);
    if (Either.isLeft(decoded)) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.run.binding",
          `<Run> requires an explicit display-vs-execute binding: ${formatErrorMessage(decoded.left)}.`,
        ),
      );
    }
  });
};

// Excludes components with a dedicated prop rule above to avoid double-reporting.
const COMPONENT_PROP_DECODERS: Record<string, (input: unknown) => Either.Either<unknown, unknown>> = {
  Step: decodeStepPropsEither,
  Variable: decodeVariablePropsEither,
  UseFixture: decodeUseFixturePropsEither,
  Inspect: decodeInspectPropsEither,
  Cleanup: decodeCleanupPropsEither,
};

const lintComponentProps = (
  sourcePath: string,
  root: MdxNode,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  walkElements(root, (node) => {
    if (node.name === undefined || node.name === null) return;
    const decode = COMPONENT_PROP_DECODERS[node.name];
    if (decode === undefined) return;
    let props: Record<string, unknown>;
    try {
      props = propsOf(node);
    } catch (error) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.component.props",
          `Invalid <${node.name}> props: ${formatErrorMessage(error)}.`,
        ),
      );
      return;
    }
    const decoded = decode(props);
    if (Either.isLeft(decoded)) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.component.props",
          `Invalid <${node.name}> props: ${formatErrorMessage(decoded.left)}.`,
        ),
      );
    }
  });
};

const lintFixtures = (
  sourcePath: string,
  root: MdxNode,
  guide: MdxNode | undefined,
  frontmatter: Record<string, unknown>,
  fixtures: ReadonlyArray<GuideFixtureInventoryEntry>,
  diagnostics: Array<GuideLintDiagnostic>,
): void => {
  const references = new Map<string, MdxNode>();
  walkElements(root, (node) => {
    if (node.name !== "UseFixture") return;
    const name = propsOf(node).name;
    if (typeof name !== "string") return;
    if (!references.has(name)) references.set(name, node);
  });

  const entriesByName = new Map<string, Array<GuideFixtureInventoryEntry>>();
  for (const entry of fixtures) {
    const list = entriesByName.get(entry.name) ?? [];
    list.push(entry);
    entriesByName.set(entry.name, list);
  }

  for (const [name, node] of references) {
    const entries = (entriesByName.get(name) ?? []).filter((entry) => entry.kind !== "other");
    if (entries.length === 0) {
      diagnostics.push(
        diagnostic(
          sourcePath,
          node,
          "guide.fixture.missing",
          `<UseFixture name="${name}"> does not resolve to a fixture directory.`,
        ),
      );
      continue;
    }
    for (const entry of entries) {
      const symlinkPaths = entry.kind === "symlink" ? [entry.sourcePath] : (entry.symlinkPaths ?? []);
      for (const symlinkPath of symlinkPaths) {
        diagnostics.push(
          diagnostic(
            sourcePath,
            node,
            "guide.fixture.symlink",
            `Fixture "${name}" contains a symbolic link at "${symlinkPath}" and cannot be copied immutably.`,
          ),
        );
      }
    }
  }

  const guideId = typeof frontmatter.id === "string" ? frontmatter.id : "";
  const anchor = guide ?? root;
  for (const entry of fixtures) {
    if (entry.scope !== "local") continue;
    if (entry.kind === "other") continue;
    if (references.has(entry.name)) continue;
    diagnostics.push(
      diagnostic(
        sourcePath,
        anchor,
        "guide.fixture.unused",
        `Fixture "${entry.name}" is not referenced by any <UseFixture> in guide "${guideId}".`,
      ),
    );
  }
};

const lintComponents = (sourcePath: string, root: MdxNode, diagnostics: Array<GuideLintDiagnostic>): void => {
  walkElements(root, (node) => {
    if (node.name === undefined || node.name === null || ALPHA_2_COMPONENTS.has(node.name)) return;
    diagnostics.push(
      diagnostic(sourcePath, node, "guide.component.beta", `<${node.name}> is not supported yet.`),
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

export const lintGuideContent = (
  sourcePath: string,
  content: string,
  options: GuideLintContentOptions = {},
): GuideLintResult => {
  const diagnostics: Array<GuideLintDiagnostic> = [];
  const root = processor.parse(content) as MdxNode;
  const frontmatter = validateFrontmatter(sourcePath, root, diagnostics);
  const guide = elementChildren(root).find((child) => child.name === "Guide");
  lintComponents(sourcePath, root, diagnostics);
  lintRawShellFences(sourcePath, guide, diagnostics);
  const scenarios = guide === undefined ? [] : lintScenarioIds(sourcePath, guide, diagnostics);
  lintScenarioProps(sourcePath, scenarios, diagnostics);
  lintHiddenScenarioReason(sourcePath, scenarios, diagnostics);
  lintHiddenReason(sourcePath, root, diagnostics);
  lintSkipReason(sourcePath, root, diagnostics);
  lintInlineJustification(sourcePath, root, diagnostics);
  lintVerifyMatchers(sourcePath, root, diagnostics);
  lintRunBindings(sourcePath, root, diagnostics);
  lintComponentProps(sourcePath, root, diagnostics);
  lintFixtures(sourcePath, root, guide, frontmatter, options.fixtures ?? [], diagnostics);
  lintStepNames(sourcePath, scenarios, diagnostics);
  lintTabs(sourcePath, root, frontmatter, diagnostics);
  lintE2eScenarios(sourcePath, scenarios, frontmatter, diagnostics);
  lintDiataxis(sourcePath, guide, frontmatter, diagnostics);
  return { diagnostics };
};

const readGuideFrontmatter = (sourcePath: string, content: string): Record<string, unknown> => {
  const root = processor.parse(content) as MdxNode;
  try {
    return parseFrontmatter(sourcePath, firstYaml(root).value);
  } catch {
    return {};
  }
};

const collectSymlinkDescendants = async (
  repoRoot: string,
  relDir: string,
): Promise<ReadonlyArray<string>> => {
  const found: Array<string> = [];
  const walk = async (rel: string): Promise<void> => {
    let entries: Array<Dirent<string>>;
    try {
      entries = await readdir(resolve(repoRoot, rel), { encoding: "utf8", withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = `${rel}/${entry.name}`;
      if (entry.isSymbolicLink()) found.push(childRel);
      else if (entry.isDirectory()) await walk(childRel);
    }
  };
  await walk(relDir);
  return found;
};

const normalizePath = (path: string): string => path.split("\\").join("/");

const pathForRoot = (repoRoot: string, absolutePath: string): string =>
  normalizePath(relative(repoRoot, absolutePath));

const discoverLintGuideMdxFiles = async (
  repoRoot: string,
  guideRoot: string | undefined,
): Promise<ReadonlyArray<string>> => {
  if (guideRoot === undefined) return discoverGuideMdxFiles(repoRoot);

  const absoluteGuideRoot = resolve(repoRoot, guideRoot);
  const found: Array<string> = [];
  const walk = async (absoluteDir: string): Promise<void> => {
    let entries: Array<Dirent<string>>;
    try {
      entries = await readdir(absoluteDir, { encoding: "utf8", withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absoluteChild = resolve(absoluteDir, entry.name);
      if (entry.isDirectory()) await walk(absoluteChild);
      else if (entry.isFile() && entry.name.endsWith(".mdx"))
        found.push(pathForRoot(repoRoot, absoluteChild));
    }
  };
  await walk(absoluteGuideRoot);
  return found.sort((left, right) => left.localeCompare(right));
};

const buildFixtureInventory = async (
  repoRoot: string,
  guideId: string,
  guideRoot = "docs/guides",
): Promise<ReadonlyArray<GuideFixtureInventoryEntry>> => {
  const roots: ReadonlyArray<{ readonly dir: string; readonly scope: "local" | "shared" }> = [
    { dir: `${guideRoot}/${guideId}/fixtures`, scope: "local" },
    { dir: `${guideRoot}/fixtures`, scope: "shared" },
  ];
  const inventory: Array<GuideFixtureInventoryEntry> = [];
  for (const { dir, scope } of roots) {
    let entries: Array<Dirent<string>>;
    try {
      entries = await readdir(resolve(repoRoot, dir), { encoding: "utf8", withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const sourcePath = `${dir}/${entry.name}`;
      let kind: "directory" | "symlink" | "other";
      let symlinkPaths: ReadonlyArray<string> = [];
      if (entry.isSymbolicLink()) {
        kind = "symlink";
      } else if (entry.isDirectory()) {
        kind = "directory";
        symlinkPaths = await collectSymlinkDescendants(repoRoot, sourcePath);
      } else {
        kind = "other";
      }
      inventory.push({
        name: entry.name,
        sourcePath,
        scope,
        kind,
        ...(symlinkPaths.length > 0 ? { symlinkPaths } : {}),
      });
    }
  }
  return inventory;
};

const allowedPublicLines = (scenario: GuideScenarioNode): ReadonlySet<number> => {
  const allowed = new Set<number>([scenario.line]);
  const addStep = (step: GuideStepNode): void => {
    if (step.hidden) return;
    allowed.add(step.line);
    for (const component of step.components) {
      if (component.kind === "Variable" || component.kind === "UseFixture") continue;
      allowed.add(component.line);
    }
  };
  for (const step of scenario.steps) addStep(step);
  for (const item of scenario.body) {
    switch (item.kind) {
      case "step":
        addStep(item.step);
        break;
      case "tabs":
        allowed.add(item.line);
        for (const tab of item.tabs) {
          allowed.add(tab.line);
          for (const step of tab.steps) addStep(step);
        }
        break;
      case "skip":
        allowed.add(item.line);
        for (const step of item.steps) addStep(step);
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
  const diagnostics: Array<GuideLintDiagnostic> = [];
  for (const frame of frames) {
    if (frame.sourceFile === sourcePath && frame.sourceLine > 0 && allowed.has(frame.sourceLine)) continue;
    diagnostics.push({
      sourcePath,
      line: frame.sourceLine > 0 ? frame.sourceLine : scenario.line,
      column: 1,
      code: "guide.transcript.leak",
      message: `Public transcript frame (${frame.kind}) at line ${frame.sourceLine} does not map to a visible scenario component; hidden steps, fixtures, and variables must be excluded.`,
    });
  }
  return diagnostics;
};

const SOURCE_HEADER_PATTERN = /^\/\/ @source: (.+):(\d+)$/;

const parseSourceHeader = (line: string): { readonly path: string; readonly line: number } | undefined => {
  const match = SOURCE_HEADER_PATTERN.exec(line);
  if (match === null) return undefined;
  const parsed = Number.parseInt(match[2] ?? "", 10);
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return { path: match[1] ?? "", line: parsed };
};

export const checkScenarioSourceMap = (
  generatedSource: string,
  sourcePath: string,
  anchorLine: number,
): ReadonlyArray<GuideLintDiagnostic> => {
  const diagnostics: Array<GuideLintDiagnostic> = [];
  const push = (message: string): void => {
    diagnostics.push({
      sourcePath,
      line: anchorLine,
      column: 1,
      code: "guide.transcript.source-map",
      message,
    });
  };
  const lines = generatedSource.split("\n").map((line) => line.trim());
  if (!lines.includes("// @generated"))
    push("Generated scenario block is missing its `// @generated` header.");
  const sourceHeaders: Array<{ readonly path: string; readonly line: number }> = [];
  for (const line of lines) {
    const sourceHeader = parseSourceHeader(line);
    if (sourceHeader !== undefined) sourceHeaders.push(sourceHeader);
  }
  if (sourceHeaders.length === 0) {
    push(`Generated scenario block is missing a \`// @source: ${sourcePath}:<line>\` header.`);
  } else {
    if (sourceHeaders.some((entry) => entry.path !== sourcePath))
      push(`Generated scenario block has a \`// @source:\` header that does not point at ${sourcePath}.`);
    if (!sourceHeaders.some((entry) => entry.path === sourcePath && entry.line === anchorLine))
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

export const lintGuideTranscripts = (
  sourcePath: string,
  content: string,
  hostPlatform: GuidePlatform = resolveHostGuidePlatform(),
): GuideLintResult => {
  let guide: GuideScenarioAst;
  try {
    guide = parseGuideScenarioAst(sourcePath, content);
  } catch (error) {
    return {
      diagnostics: [
        {
          sourcePath,
          line: 1,
          column: 1,
          code: "guide.transcript.parse",
          message: `Could not parse guide scenarios: ${formatErrorMessage(error)}`,
        },
      ],
    };
  }
  const diagnostics: Array<GuideLintDiagnostic> = [];
  for (const scenario of guide.scenarios) {
    for (const variant of variantsOf(guide)) {
      try {
        const transcript = buildPublicTranscript(guide, scenario, variant);
        if (transcript !== undefined)
          diagnostics.push(...checkTranscriptFrameDiscipline(scenario, transcript.frames, sourcePath));
        const generated = renderScenarioTest(guide, scenario, variant, hostPlatform);
        diagnostics.push(...checkScenarioSourceMap(generated, sourcePath, scenario.line));
      } catch (error) {
        diagnostics.push({
          sourcePath,
          line: scenario.line,
          column: 1,
          code: "guide.transcript.build",
          message: `Could not build scenario transcript: ${formatErrorMessage(error)}`,
        });
      }
    }
  }
  return { diagnostics };
};

export const lintGuides = async (
  root = REPO_ROOT,
  options: GuideLintOptions = {},
): Promise<GuideLintResult> => {
  const diagnostics: Array<GuideLintDiagnostic> = [];
  const files = await discoverLintGuideMdxFiles(root, options.guideRoot);
  for (const sourcePath of files) {
    const content = await Bun.file(resolve(root, sourcePath)).text();
    const frontmatter = readGuideFrontmatter(sourcePath, content);
    const guideId = typeof frontmatter.id === "string" ? frontmatter.id : undefined;
    const fixtures =
      guideId === undefined ? [] : await buildFixtureInventory(root, guideId, options.guideRoot);
    const result = lintGuideContent(sourcePath, content, { fixtures });
    diagnostics.push(...result.diagnostics);
    if (result.diagnostics.length === 0)
      diagnostics.push(...lintGuideTranscripts(sourcePath, content).diagnostics);
  }
  return { diagnostics };
};

export const formatGuideLintDiagnostic = (entry: GuideLintDiagnostic): string =>
  `${entry.sourcePath}:${entry.line}:${entry.column}: ${entry.code}: ${entry.message}`;

const main = async (): Promise<void> => {
  const guideRoot = process.env.GUIDES_DIR_OVERRIDE;
  const result = await lintGuides(REPO_ROOT, {
    ...(guideRoot === undefined || guideRoot.trim() === "" ? {} : { guideRoot }),
  });
  if (result.diagnostics.length === 0) {
    process.stdout.write("Guide lint passed.\n");
    return;
  }
  process.stderr.write(`${result.diagnostics.map(formatGuideLintDiagnostic).join("\n")}\n`);
  process.exitCode = 1;
};

if (import.meta.main) await main();
