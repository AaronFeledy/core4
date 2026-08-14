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

type MdxElement = MdxJsxFlowElement | MdxJsxTextElement;

type GuideContext = {
  readonly guideId: string;
  readonly scenarioId: string | undefined;
  readonly tabsAxis: string | undefined;
  readonly variant: readonly string[];
  readonly sourceFile: string | undefined;
  readonly source: string | undefined;
};

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isParent = (node: Node): node is Parent => "children" in node && Array.isArray(node.children);

const isMdxElement = (node: Node): node is MdxElement =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

const isMdxTextExpression = (node: Node): node is MdxTextExpression => node.type === "mdxTextExpression";

const isMdxFlowExpression = (node: Node): node is MdxFlowExpression => node.type === "mdxFlowExpression";

const isContextElement = (element: MdxElement): boolean => {
  switch (element.name) {
    case "Step":
    case "Run":
    case "Verify":
    case "Inspect":
    case "Cleanup":
    case "Inline":
    case "Tab":
      return true;
    default:
      return false;
  }
};

const attributeNamed = (element: MdxElement, name: string): MdxJsxAttribute | undefined =>
  element.attributes.find(
    (attribute): attribute is MdxJsxAttribute =>
      attribute.type === "mdxJsxAttribute" && attribute.name === name,
  );

const stringAttribute = (element: MdxElement, name: string): string | undefined => {
  const value = attributeNamed(element, name)?.value;
  return typeof value === "string" ? value : undefined;
};

const setStringAttribute = (element: MdxElement, name: string, value: string): void => {
  const attribute = attributeNamed(element, name);
  if (attribute === undefined) {
    element.attributes.push({ type: "mdxJsxAttribute", name, value });
    return;
  }
  attribute.value = value;
};

const guideIdFrom = (file: VFile): string | undefined => {
  const astroData: unknown = file.data.astro;
  if (!isRecord(astroData)) return undefined;
  const frontmatter = astroData.frontmatter;
  if (!isRecord(frontmatter)) return undefined;
  const guideId = frontmatter.id;
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

const contextInside = (element: MdxElement, context: GuideContext): GuideContext => {
  if (element.name === "Scenario") {
    return { ...context, scenarioId: stringAttribute(element, "id") };
  }
  if (element.name === "Tabs") {
    return { ...context, tabsAxis: stringAttribute(element, "axis") };
  }
  if (element.name === "Tab") {
    const tabName = stringAttribute(element, "name");
    if (context.tabsAxis !== undefined && tabName !== undefined) {
      return { ...context, variant: [...context.variant, `${context.tabsAxis}=${tabName}`] };
    }
  }
  return context;
};

const injectContext = (element: MdxElement, context: GuideContext): void => {
  if (!isContextElement(element)) return;
  setStringAttribute(element, "data-guide-id", context.guideId);
  if (context.sourceFile !== undefined) setStringAttribute(element, "data-source-file", context.sourceFile);
  if (element.position?.start.line !== undefined) {
    setStringAttribute(element, "data-source-line", String(element.position.start.line));
  }
  if (context.scenarioId !== undefined) {
    setStringAttribute(element, "data-scenario-id", context.scenarioId);
  }
  if (context.variant.length > 0) setStringAttribute(element, "data-variant", context.variant.join(" "));
  if (element.name !== "Tab") return;
  if (context.tabsAxis !== undefined) setStringAttribute(element, "data-axis", context.tabsAxis);
  const tabName = stringAttribute(element, "name");
  if (tabName !== undefined) setStringAttribute(element, "data-tab-name", tabName);
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
      const childContext = contextInside(child, context);
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
    const guideId = guideIdFrom(file);
    if (guideId === undefined) return;
    transformChildren(tree, {
      guideId,
      scenarioId: undefined,
      tabsAxis: undefined,
      variant: [],
      sourceFile: sourceFileFrom(file),
      source: typeof file.value === "string" ? file.value : undefined,
    });
  };
