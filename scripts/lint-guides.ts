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
import { decodeGuideFrontmatterEither, decodeVerifyPropsEither } from "../sdk/src/docs/components/index.ts";
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
        "<Scenario render={false}> requires a `reason` of at least 8 characters.",
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
  const scenarios = guide === undefined ? [] : lintScenarioIds(sourcePath, guide, diagnostics);
  lintHiddenScenarioReason(sourcePath, scenarios, diagnostics);
  lintHiddenReason(sourcePath, root, diagnostics);
  lintSkipReason(sourcePath, root, diagnostics);
  lintInlineJustification(sourcePath, root, diagnostics);
  lintVerifyMatchers(sourcePath, root, diagnostics);
  lintFixtures(sourcePath, root, guide, frontmatter, options.fixtures ?? [], diagnostics);
  lintStepNames(sourcePath, scenarios, diagnostics);
  lintTabs(sourcePath, root, frontmatter, diagnostics);
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
