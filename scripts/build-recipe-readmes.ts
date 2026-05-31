#!/usr/bin/env bun
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { Effect, Either } from "effect";
import { toMarkdown } from "mdast-util-to-markdown";
import remarkFrontmatter from "remark-frontmatter";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";

import { parseLandofile } from "../core/src/landofile/parser.ts";
import { type GuideFrontmatter, decodeGuideFrontmatterEither } from "../sdk/src/docs/components/index.ts";
import { GuideFrontmatterValidationError } from "../sdk/src/errors/index.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const RECIPES_ROOT = "recipes";
const SCAFFOLD_DIR = ".scaffold";
const SINGLETON_FILE = "default";

const isNotFound = (cause: unknown): boolean =>
  cause !== null && typeof cause === "object" && (cause as { code?: unknown }).code === "ENOENT";

type MdxNode = {
  type: string;
  name?: string | null;
  value?: unknown;
  lang?: string | null;
  depth?: number;
  attributes?: ReadonlyArray<MdxAttribute>;
  children?: Array<MdxNode>;
};

type MdxAttribute = {
  readonly type: string;
  readonly name?: string;
  readonly value?:
    | string
    | null
    | { readonly type?: string; readonly value?: string; readonly data?: unknown };
};

const processor = unified().use(remarkParse).use(remarkMdx).use(remarkFrontmatter, ["yaml"]);

const DEFAULT_AXIS = "default";

interface VariantPair {
  readonly axis: string;
  readonly value: string;
}

export interface RecipeReadmeOutput {
  readonly fileName: string;
  readonly relativePath: string;
  readonly markdown: string;
}

export interface BuildRecipeReadmeOptions {
  readonly onlyRecipe?: string;
}

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

const elementChildren = (node: MdxNode): ReadonlyArray<MdxNode> =>
  (node.children ?? []).filter(
    (child) => child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement",
  );

const firstYaml = (root: MdxNode): string | undefined =>
  root.children?.find((child) => child.type === "yaml")?.value as string | undefined;

const parseFrontmatter = (sourcePath: string, yaml: string | undefined): Record<string, unknown> => {
  if (yaml === undefined) return {};
  try {
    const parsed = Effect.runSync(
      parseLandofile({ file: sourcePath, content: yaml, cwd: dirname(sourcePath) }),
    );
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (error) {
    throw new GuideFrontmatterValidationError({
      message: `Invalid recipe README frontmatter at ${sourcePath}.`,
      sourcePath,
      field: "frontmatter",
      rejectedValue: yaml,
      issues: [String(error)],
      remediation: `Fix the YAML frontmatter in ${sourcePath}.`,
    });
  }
};

const decodeFrontmatter = (sourcePath: string, input: Record<string, unknown>): GuideFrontmatter => {
  const decoded = decodeGuideFrontmatterEither(input);
  if (Either.isRight(decoded)) return decoded.right;
  throw new GuideFrontmatterValidationError({
    message: `Recipe README frontmatter is invalid at ${sourcePath}.`,
    sourcePath,
    field: "frontmatter",
    rejectedValue: input,
    issues: [String(decoded.left)],
    remediation: `Fix the recipe README frontmatter in ${sourcePath}.`,
  });
};

const axisEntriesOf = (
  frontmatter: GuideFrontmatter,
): ReadonlyArray<readonly [string, ReadonlyArray<string>]> => {
  if (frontmatter.tabs !== undefined && frontmatter.tabs.length > 0) {
    return [[DEFAULT_AXIS, frontmatter.tabs]];
  }
  if (frontmatter.axes !== undefined) return Object.entries(frontmatter.axes);
  return [];
};

const variantsOf = (frontmatter: GuideFrontmatter): ReadonlyArray<ReadonlyArray<VariantPair>> => {
  const entries = axisEntriesOf(frontmatter);
  if (entries.length === 0) return [[]];
  let combinations: ReadonlyArray<ReadonlyArray<VariantPair>> = [[]];
  for (const [axis, values] of entries) {
    combinations = combinations.flatMap((prefix) => values.map((value) => [...prefix, { axis, value }]));
  }
  return combinations;
};

const fileNameOf = (pairs: ReadonlyArray<VariantPair>): string =>
  pairs.length === 0 ? SINGLETON_FILE : pairs.map((pair) => pair.value).join(".");

const interpolate = (value: string, variables: ReadonlyMap<string, string>): string =>
  value.replace(/\{\{\s*([A-Za-z_$][\w$-]*)\s*\}\}/g, (_match, name: string) => variables.get(name) ?? "");

// <Variable> supplies `display` (falling back to `value`) for stripped README interpolation.
const collectVariables = (node: MdxNode, variables: Map<string, string>): void => {
  if (node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement") {
    if (node.name === "Variable") {
      const props = propsOf(node);
      const name = typeof props.name === "string" ? props.name : undefined;
      if (name !== undefined) {
        const display = typeof props.display === "string" ? props.display : undefined;
        const value = typeof props.value === "string" ? props.value : "";
        variables.set(name, display ?? value);
      }
    }
  }
  for (const child of node.children ?? []) collectVariables(child, variables);
};

const headingNode = (depth: number, text: string): MdxNode => ({
  type: "heading",
  depth,
  children: [{ type: "text", value: text }],
});

const codeNode = (lang: string | null, value: string): MdxNode => ({ type: "code", lang, value });

interface StripContext {
  readonly variables: ReadonlyMap<string, string>;
  readonly variant: ReadonlyArray<VariantPair>;
  stepCounter: number;
  readonly cleanups: Array<string>;
}

const displayedCommand = (props: Record<string, unknown>, variables: ReadonlyMap<string, string>): string => {
  const command = typeof props.command === "string" ? props.command : undefined;
  if (command !== undefined) return interpolate(command, variables);
  const shell = typeof props.shell === "string" ? props.shell : "";
  return interpolate(shell, variables);
};

// A step that contains a <Cleanup/> marker is a teardown step: its <Run> commands are
// deferred into the final "Cleanup" block and the step emits no numbered heading.
const isCleanupStep = (step: MdxNode): boolean =>
  elementChildren(step).some((child) => child.name === "Cleanup");

const stripStepComponents = (step: MdxNode, ctx: StripContext): ReadonlyArray<MdxNode> => {
  const output: MdxNode[] = [];
  for (const component of elementChildren(step)) {
    const props = propsOf(component);
    switch (component.name) {
      case "Run":
        output.push(codeNode("bash", displayedCommand(props, ctx.variables)));
        break;
      case "Inspect":
        // No runtime transcript is available while stripping, so emit a placeholder.
        output.push(codeNode(null, "(generated at runtime)"));
        break;
      case "Inline": {
        const lang = typeof props.lang === "string" ? props.lang : "ts";
        const code = typeof props.code === "string" ? props.code : "";
        output.push(codeNode(lang, code));
        break;
      }
      // <Verify>, <Variable>, <UseFixture> render nothing in the stripped README.
      default:
        break;
    }
  }
  return output;
};

const stripStep = (step: MdxNode, ctx: StripContext): ReadonlyArray<MdxNode> => {
  const props = propsOf(step);
  const name = typeof props.name === "string" ? props.name : "step";
  if (isCleanupStep(step)) {
    for (const child of elementChildren(step)) {
      if (child.name === "Run") ctx.cleanups.push(displayedCommand(propsOf(child), ctx.variables));
    }
    return [];
  }
  ctx.stepCounter += 1;
  return [headingNode(2, `${ctx.stepCounter}. ${name}`), ...stripStepComponents(step, ctx)];
};

const matchedTab = (tabs: MdxNode, ctx: StripContext): MdxNode | undefined => {
  const axisProp = propsOf(tabs).axis;
  const [firstPair] = ctx.variant;
  const axis =
    typeof axisProp === "string"
      ? axisProp
      : ctx.variant.length === 1 && firstPair !== undefined
        ? firstPair.axis
        : DEFAULT_AXIS;
  const value = ctx.variant.find((pair) => pair.axis === axis)?.value;
  if (value === undefined) return undefined;
  return elementChildren(tabs).find((child) => child.name === "Tab" && propsOf(child).name === value);
};

const stripScenarioChild = (child: MdxNode, ctx: StripContext): ReadonlyArray<MdxNode> => {
  if (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") {
    switch (child.name) {
      case "Step":
        return stripStep(child, ctx);
      case "Tabs": {
        const tab = matchedTab(child, ctx);
        if (tab === undefined) return [];
        return elementChildren(tab)
          .filter((node) => node.name === "Step")
          .flatMap((node) => stripStep(node, ctx));
      }
      // <Hidden> and <Skip> blocks (and any other component) are omitted from the README.
      default:
        return [];
    }
  }
  return [];
};

const stripScenario = (scenario: MdxNode, ctx: StripContext): ReadonlyArray<MdxNode> => {
  const props = propsOf(scenario);
  // Test-only scenarios (render={false}) are omitted entirely.
  if (props.render === false) return [];
  return (scenario.children ?? []).flatMap((child) => stripScenarioChild(child, ctx));
};

const stripGuide = (guide: MdxNode, ctx: StripContext): ReadonlyArray<MdxNode> =>
  (guide.children ?? []).flatMap((child) => {
    if (
      (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") &&
      child.name === "Scenario"
    ) {
      return stripScenario(child, ctx);
    }
    // Non-scenario prose inside <Guide> is preserved when it carries real content.
    if (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") return [];
    return [child];
  });

const guideScaffoldStripDisabled = (root: MdxNode): boolean => {
  const guide = elementChildren(root).find((child) => child.name === "Guide");
  return guide !== undefined && propsOf(guide).scaffoldStrip === false;
};

export const stripRecipeReadme = (sourcePath: string, content: string): ReadonlyArray<RecipeReadmeOutput> => {
  const root = processor.parse(content) as MdxNode;
  const frontmatter = decodeFrontmatter(sourcePath, parseFrontmatter(sourcePath, firstYaml(root)));
  const recipeId = frontmatter.id;
  const variants = variantsOf(frontmatter);
  const scaffoldStripDisabled = guideScaffoldStripDisabled(root);

  return variants.map((pairs) => {
    const fileName = fileNameOf(pairs);
    const relativePath = `${RECIPES_ROOT}/${recipeId}/${SCAFFOLD_DIR}/${fileName}.md`;
    if (scaffoldStripDisabled) {
      return { fileName, relativePath, markdown: content };
    }
    const variables = new Map<string, string>();
    collectVariables(root, variables);
    const ctx: StripContext = { variables, variant: pairs, stepCounter: 0, cleanups: [] };
    const children: MdxNode[] = [];
    for (const child of root.children ?? []) {
      if (child.type === "yaml") continue;
      if (
        (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") &&
        child.name === "Guide"
      ) {
        children.push(...stripGuide(child, ctx));
        continue;
      }
      if (child.type === "mdxJsxFlowElement" || child.type === "mdxJsxTextElement") continue;
      children.push(child);
    }
    if (ctx.cleanups.length > 0) {
      children.push(headingNode(2, "Cleanup"));
      children.push(codeNode("bash", ctx.cleanups.join("\n")));
    }
    const markdown = toMarkdown({ type: "root", children } as never);
    return { fileName, relativePath, markdown };
  });
};

export const discoverRecipeReadmeMdxFiles = async (root = REPO_ROOT): Promise<ReadonlyArray<string>> => {
  const recipesRoot = resolve(root, RECIPES_ROOT);
  let entries: Awaited<ReturnType<typeof readdir>>;
  try {
    entries = await readdir(recipesRoot, { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${RECIPES_ROOT}/${entry.name}/README.mdx`);
  const existing = await Promise.all(
    candidates.map(async (path) => ((await Bun.file(resolve(root, path)).exists()) ? path : undefined)),
  );
  return existing
    .filter((path): path is string => path !== undefined)
    .sort((left, right) => left.localeCompare(right));
};

export const buildRecipeReadmes = async (
  root = REPO_ROOT,
  options: BuildRecipeReadmeOptions = {},
): Promise<ReadonlyArray<string>> => {
  const files = await discoverRecipeReadmeMdxFiles(root);
  const written: string[] = [];
  for (const sourcePath of files) {
    const recipeId = sourcePath.split("/")[1];
    if (options.onlyRecipe !== undefined && recipeId !== options.onlyRecipe) continue;
    const content = await Bun.file(resolve(root, sourcePath)).text();
    const outputs = stripRecipeReadme(sourcePath, content);
    if (outputs.length === 0) continue;
    const scaffoldDir = dirname(outputs[0]?.relativePath ?? "");
    await rm(resolve(root, scaffoldDir), { force: true, recursive: true });
    await mkdir(resolve(root, scaffoldDir), { recursive: true });
    for (const output of outputs) {
      await Bun.write(resolve(root, output.relativePath), output.markdown);
      written.push(output.relativePath);
    }
  }
  return written.sort((left, right) => left.localeCompare(right));
};

const main = async (): Promise<void> => {
  try {
    const written = await buildRecipeReadmes(REPO_ROOT);
    process.stdout.write(`${JSON.stringify(written, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(error, null, 2)}\n`);
    process.exitCode = 1;
  }
};

if (import.meta.main) await main();
