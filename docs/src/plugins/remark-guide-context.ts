import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";

import type { Paragraph, Root, Text } from "mdast";
import type {
  MdxFlowExpression,
  MdxJsxAttribute,
  MdxJsxFlowElement,
  MdxJsxTextElement,
  MdxTextExpression,
} from "mdast-util-mdx";
import type { Node, Parent } from "unist";
import type { VFile } from "vfile";

import {
  type GuidePresentation,
  firstYaml,
  processor as guideProcessor,
  parseFrontmatter,
  projectGuidePresentation,
} from "@lando/core/docs/guide-compiler";

import { CONTEXT_COMPONENT_NAMES } from "../components/vocabulary.ts";

type MdxElement = MdxJsxFlowElement | MdxJsxTextElement;

type GuideContext = {
  readonly guideId: string;
  readonly sourceFile: string | undefined;
  readonly source: string | undefined;
  readonly presentation: GuidePresentation | undefined;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isParent = (node: Node): node is Parent => "children" in node && Array.isArray(node.children);

const isMdxElement = (node: Node): node is MdxElement =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

const isMdxTextExpression = (node: Node): node is MdxTextExpression => node.type === "mdxTextExpression";

const isMdxFlowExpression = (node: Node): node is MdxFlowExpression => node.type === "mdxFlowExpression";

const CONTEXT_ELEMENT_NAME_SET: ReadonlySet<string> = new Set(CONTEXT_COMPONENT_NAMES);

const isContextElement = (element: MdxElement): boolean =>
  element.name !== null && CONTEXT_ELEMENT_NAME_SET.has(element.name);

const attributeNamed = (element: MdxElement, name: string): MdxJsxAttribute | undefined =>
  element.attributes.find(
    (attribute): attribute is MdxJsxAttribute =>
      attribute.type === "mdxJsxAttribute" && attribute.name === name,
  );

const setStringAttribute = (element: MdxElement, name: string, value: string): void => {
  const attribute = attributeNamed(element, name);
  if (attribute === undefined) {
    element.attributes.push({ type: "mdxJsxAttribute", name, value });
    return;
  }
  attribute.value = value;
};

const frontmatterFrom = (file: VFile): Readonly<Record<string, unknown>> | undefined => {
  const astroData: unknown = file.data.astro;
  if (!isRecord(astroData)) return undefined;
  const frontmatter = astroData.frontmatter;
  return isRecord(frontmatter) ? frontmatter : undefined;
};

const guideIdFrom = (file: VFile): string | undefined => {
  const guideId = frontmatterFrom(file)?.id;
  return typeof guideId === "string" ? guideId : undefined;
};

const sourceFileFrom = (file: VFile): string | undefined => {
  if (file.path === undefined || file.path === "") return undefined;
  const normalized = file.path.replaceAll("\\", "/");
  for (const marker of ["/docs/", "/recipes/"] as const) {
    const index = normalized.lastIndexOf(marker);
    if (index >= 0) return normalized.slice(index + 1);
  }
  return relative(process.cwd(), file.path).replaceAll("\\", "/");
};

const hasFalseRenderExpression = (element: MdxElement): boolean => {
  const value = attributeNamed(element, "render")?.value;
  return (
    typeof value === "object" &&
    value !== null &&
    value.type === "mdxJsxAttributeValueExpression" &&
    value.value.trim() === "false"
  );
};

const injectContext = (element: MdxElement, context: GuideContext): void => {
  if (!isContextElement(element)) return;
  const projected = context.presentation?.contexts.get(element);
  setStringAttribute(element, "data-guide-id", projected?.guideId ?? context.guideId);
  if (context.sourceFile !== undefined) setStringAttribute(element, "data-source-file", context.sourceFile);
  if (element.position?.start.line !== undefined)
    setStringAttribute(element, "data-source-line", String(element.position.start.line));
  if (projected?.scenarioId !== undefined)
    setStringAttribute(element, "data-scenario-id", projected.scenarioId);
  if (projected?.variant !== undefined) setStringAttribute(element, "data-variant", projected.variant);
  if (projected?.axis !== undefined) setStringAttribute(element, "data-axis", projected.axis);
  if (projected?.tabName !== undefined) setStringAttribute(element, "data-tab-name", projected.tabName);
};

const expressionSource = (
  expression: MdxFlowExpression | MdxTextExpression,
  source: string | undefined,
): string => {
  const start = expression.position?.start.offset;
  const end = expression.position?.end.offset;
  if (source !== undefined && start !== undefined && end !== undefined) return source.slice(start, end);
  return `{${expression.value}}`;
};

const literalText = (
  expression: MdxFlowExpression | MdxTextExpression,
  source: string | undefined,
): Text => ({
  type: "text",
  value: expressionSource(expression, source),
  position: expression.position,
});

const literalParagraph = (expression: MdxFlowExpression, source: string | undefined): Paragraph => ({
  type: "paragraph",
  children: [literalText(expression, source)],
  position: expression.position,
});

const transformChildren = (parent: Parent, context: GuideContext): void => {
  const children: Node[] = [];
  for (const child of parent.children) {
    if (isMdxTextExpression(child)) {
      children.push(literalText(child, context.source));
      continue;
    }
    if (isMdxFlowExpression(child)) {
      children.push(literalParagraph(child, context.source));
      continue;
    }
    if (isMdxElement(child)) {
      if (child.name === "Hidden") continue;
      if (child.name === "Scenario" && hasFalseRenderExpression(child)) continue;
      const childContext = context;
      injectContext(child, childContext);
      transformChildren(child, childContext);
      children.push(child);
      continue;
    }
    if (isParent(child)) transformChildren(child, context);
    children.push(child);
  }
  parent.children = children;
};

export const remarkGuideContext =
  () =>
  (tree: Root, file: VFile): void => {
    const metadataGuideId = guideIdFrom(file);
    // Astro enriches frontmatter with page metadata outside the guide schema.
    const containsGuide = (node: Node): boolean =>
      (isMdxElement(node) && node.name === "Guide") || (isParent(node) && node.children.some(containsGuide));
    const presentation = containsGuide(tree)
      ? (() => {
          const source = existsSync(file.path) ? readFileSync(file.path, "utf8") : String(file.value);
          const authored = parseFrontmatter(file.path, firstYaml(guideProcessor.parse(source)));
          return projectGuidePresentation(file.path, tree, authored);
        })()
      : undefined;
    const guideId = presentation?.guideId ?? metadataGuideId;
    if (guideId === undefined) return;
    transformChildren(tree, {
      guideId,
      sourceFile: sourceFileFrom(file),
      source: typeof file.value === "string" ? file.value : undefined,
      presentation,
    });
  };
