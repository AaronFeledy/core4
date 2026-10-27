#!/usr/bin/env bun
import type { Dirent } from "node:fs";
import { mkdir, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { RootContent } from "mdast";
import { toMarkdown } from "mdast-util-to-markdown";
import { elementChildren, propsOf } from "./guides/mdx.ts";
import type { GuideScenarioAst, GuideStepComponent, GuideStepNode, GuideVariant } from "./guides/model.ts";
import { parseGuideScenarioAst } from "./guides/parser.ts";
import { resolveScenario } from "./guides/resolve.ts";
import { variantsOf } from "./guides/variants.ts";

const REPO_ROOT = resolve(import.meta.dirname, "..");
const isNotFound = (cause: unknown): boolean =>
  cause !== null && typeof cause === "object" && "code" in cause && cause.code === "ENOENT";
export interface RecipeReadmeOutput {
  readonly fileName: string;
  readonly relativePath: string;
  readonly markdown: string;
}
export interface BuildRecipeReadmeOptions {
  readonly onlyRecipe?: string;
}
type DisplayedRun = { readonly lang: "bash" | "ts"; readonly text: string };
type StripContext = {
  stepCounter: number;
  readonly cleanups: Array<DisplayedRun>;
  readonly guide: GuideScenarioAst;
  readonly variant: GuideVariant | undefined;
};
const headingNode = (text: string): RootContent => ({
  type: "heading",
  depth: 2,
  children: [{ type: "text", value: text }],
});
const codeNode = (lang: string | null, value: string): RootContent => ({ type: "code", lang, value });
const displayedRun = (component: Extract<GuideStepComponent, { kind: "Run" }>): DisplayedRun => {
  const props = component.props;
  return "runtime" in props
    ? { lang: "ts", text: props.displayCode }
    : { lang: "bash", text: "command" in props ? props.command : props.shell };
};
const cleanupCodeNodes = (runs: ReadonlyArray<DisplayedRun>): ReadonlyArray<RootContent> => {
  const groups: Array<{ readonly lang: DisplayedRun["lang"]; readonly texts: string[] }> = [];
  for (const run of runs) {
    const previous = groups.at(-1);
    if (previous?.lang === run.lang) previous.texts.push(run.text);
    else groups.push({ lang: run.lang, texts: [run.text] });
  }
  return groups.map(({ lang, texts }) => codeNode(lang, texts.join("\n")));
};
const stripStep = (step: GuideStepNode, ctx: StripContext): ReadonlyArray<RootContent> => {
  if (step.components.some((component) => component.kind === "Cleanup")) {
    for (const component of step.components)
      if (component.kind === "Run") ctx.cleanups.push(displayedRun(component));
    return [];
  }
  ctx.stepCounter += 1;
  return [
    headingNode(`${ctx.stepCounter}. ${step.stepName}`),
    ...step.components.flatMap((component) => {
      switch (component.kind) {
        case "Run": {
          const run = displayedRun(component);
          return [codeNode(run.lang, run.text)];
        }
        case "Inspect":
          return [codeNode(null, "(generated at runtime)")];
        case "Inline":
          return [codeNode(component.props.lang, component.props.code)];
        case "Verify":
        case "Variable":
        case "UseFixture":
        case "Cleanup":
          return [];
      }
    }),
  ];
};
const stripGuide = (
  node: Extract<RootContent, { readonly type: "mdxJsxFlowElement" }>,
  ctx: StripContext,
): ReadonlyArray<RootContent> =>
  node.children.flatMap((child) => {
    if (child.type === "mdxJsxFlowElement" && child.name === "Scenario") {
      const { id } = propsOf(child, ctx.guide.sourcePath);
      const scenario = ctx.guide.scenarios.find((candidate) => candidate.id === id);
      if (scenario !== undefined)
        return resolveScenario(ctx.guide, scenario, ctx.variant).publicSteps.flatMap((step) =>
          stripStep(step, ctx),
        );
    }
    return child.type === "mdxJsxFlowElement" ? [] : [child];
  });

export const stripRecipeReadme = (sourcePath: string, content: string): ReadonlyArray<RecipeReadmeOutput> => {
  const guide = parseGuideScenarioAst(sourcePath, content);
  const guideNode = elementChildren(guide.root).find((child) => child.name === "Guide");
  const verbatim = guideNode !== undefined && propsOf(guideNode, sourcePath).scaffoldStrip === false;
  return variantsOf(guide).map((variant) => {
    const fileName =
      variant === undefined || variant.pairs.length === 0
        ? "default"
        : variant.pairs.map((pair) => pair.value).join(".");
    const relativePath = `recipes/${guide.frontmatter.id}/.scaffold/${fileName}.md`;
    if (verbatim) return { fileName, relativePath, markdown: content };
    const ctx: StripContext = { stepCounter: 0, cleanups: [], guide, variant };
    const children: RootContent[] = [];
    for (const child of guide.root.children) {
      if (child.type === "yaml") continue;
      if (child.type === "mdxJsxFlowElement" && child.name === "Guide")
        children.push(...stripGuide(child, ctx));
      else if (child.type !== "mdxJsxFlowElement" && child.type !== "mdxJsxTextElement") children.push(child);
    }
    if (ctx.cleanups.length > 0) children.push(headingNode("Cleanup"), ...cleanupCodeNodes(ctx.cleanups));
    return { fileName, relativePath, markdown: toMarkdown({ type: "root", children }) };
  });
};

export const discoverRecipeReadmeMdxFiles = async (root = REPO_ROOT): Promise<ReadonlyArray<string>> => {
  let entries: ReadonlyArray<Dirent<string>>;
  try {
    entries = await readdir(resolve(root, "recipes"), { withFileTypes: true });
  } catch (cause) {
    if (isNotFound(cause)) return [];
    throw cause;
  }
  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => `recipes/${entry.name}/README.mdx`);
  const existing = await Promise.all(
    candidates.map(async (path) => ((await Bun.file(resolve(root, path)).exists()) ? path : undefined)),
  );
  return existing.filter((path): path is string => path !== undefined).sort((a, b) => a.localeCompare(b));
};
export const buildRecipeReadmes = async (
  root = REPO_ROOT,
  options: BuildRecipeReadmeOptions = {},
): Promise<ReadonlyArray<string>> => {
  const files = await discoverRecipeReadmeMdxFiles(root);
  const outputs = (
    await Promise.all(
      files
        .filter((path) => options.onlyRecipe === undefined || path.split("/")[1] === options.onlyRecipe)
        .map(async (path) => stripRecipeReadme(path, await Bun.file(resolve(root, path)).text())),
    )
  ).flat();
  for (const dir of new Set(outputs.map((output) => dirname(output.relativePath)))) {
    await rm(resolve(root, dir), { force: true, recursive: true });
    await mkdir(resolve(root, dir), { recursive: true });
  }
  for (const output of outputs) await Bun.write(resolve(root, output.relativePath), output.markdown);
  return outputs.map((output) => output.relativePath).sort((a, b) => a.localeCompare(b));
};
if (import.meta.main) {
  try {
    process.stdout.write(`${JSON.stringify(await buildRecipeReadmes(REPO_ROOT), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${JSON.stringify(error, null, 2)}\n`);
    process.exitCode = 1;
  }
}
