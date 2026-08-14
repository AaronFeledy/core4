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

import { encodeVariantPair, encodeVariantString } from "@lando/core/docs/variant";

import { CONTEXT_COMPONENT_NAMES } from "../components/vocabulary.ts";

type MdxElement = MdxJsxFlowElement | MdxJsxTextElement;

type GuideContext = {
  readonly guideId: string;
  readonly scenarioId: string | undefined;
  readonly tabsAxis: string | undefined;
  /** Encounter-order pairs when no axes declaration exists (legacy single-axis prop path). */
  readonly selectedPairs: readonly string[];
  /** Axis → selected tab value for the current nesting path. */
  readonly axisSelections: Readonly<Record<string, string>>;
  readonly sourceFile: string | undefined;
  readonly source: string | undefined;
  /** Frontmatter `tabs:` present — axisless Tabs resolve to the default axis. */
  readonly hasTabsDeclaration: boolean;
  /** Declared axis names in frontmatter order (`tabs` → `["default"]`). */
  readonly axisOrder: readonly string[];
  /** First declared value per axis for Cartesian completion of unresolved axes. */
  readonly axisDefaults: Readonly<Record<string, string>>;
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

const DEFAULT_TABS_AXIS = "default";

const stringList = (input: unknown): readonly string[] | undefined =>
  Array.isArray(input) ? input.filter((value): value is string => typeof value === "string") : undefined;

type AxisDeclaration = {
  readonly axisOrder: readonly string[];
  readonly axisDefaults: Readonly<Record<string, string>>;
  readonly hasTabsDeclaration: boolean;
};

/** Mirror build-guide-scenarios `axisEntriesOf`: tabs → [[default, tabs]]; else axes entries. */
const axisDeclarationFrom = (frontmatter: Readonly<Record<string, unknown>>): AxisDeclaration => {
  const hasTabsDeclaration = Object.hasOwn(frontmatter, "tabs");
  if (hasTabsDeclaration) {
    const tabs = stringList(frontmatter.tabs) ?? [];
    const first = tabs[0];
    return {
      hasTabsDeclaration: true,
      axisOrder: [DEFAULT_TABS_AXIS],
      axisDefaults: first === undefined ? {} : { [DEFAULT_TABS_AXIS]: first },
    };
  }
  const axes = frontmatter.axes;
  if (!isRecord(axes)) {
    return { hasTabsDeclaration: false, axisOrder: [], axisDefaults: {} };
  }
  const axisOrder = Object.keys(axes);
  const axisDefaults: Record<string, string> = {};
  for (const axis of axisOrder) {
    const values = stringList(axes[axis]);
    const first = values?.[0];
    if (first !== undefined) axisDefaults[axis] = first;
  }
  return { hasTabsDeclaration: false, axisOrder, axisDefaults };
};

/** Mirror lint-guides / build-guide-scenarios default-axis rules for axisless Tabs. */
const resolveTabsAxis = (element: MdxElement, context: GuideContext): string | undefined => {
  if (context.hasTabsDeclaration) return DEFAULT_TABS_AXIS;
  const axisProp = stringAttribute(element, "axis");
  if (axisProp !== undefined) return axisProp;
  if (context.axisOrder.length === 1) return context.axisOrder[0];
  return undefined;
};

/**
 * Complete the current tab path to a full Cartesian variant string.
 * Declared axes: fill unresolved axes with first declared value; pairs follow declaration order.
 * Undeclared: emit encounter-order selected pairs only.
 */
const variantStringOf = (context: GuideContext): string | undefined => {
  if (context.axisOrder.length > 0) {
    if (Object.keys(context.axisSelections).length === 0) return undefined;
    const pairs = context.axisOrder.flatMap((axis) => {
      const value = context.axisSelections[axis] ?? context.axisDefaults[axis];
      return value === undefined ? [] : [encodeVariantPair(axis, value)];
    });
    return pairs.length === 0 ? undefined : encodeVariantString(pairs);
  }
  return context.selectedPairs.length === 0 ? undefined : encodeVariantString(context.selectedPairs);
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
    return { ...context, tabsAxis: resolveTabsAxis(element, context) };
  }
  if (element.name === "Tab") {
    const tabName = stringAttribute(element, "name");
    if (context.tabsAxis !== undefined && tabName !== undefined) {
      return {
        ...context,
        axisSelections: { ...context.axisSelections, [context.tabsAxis]: tabName },
        selectedPairs: [...context.selectedPairs, encodeVariantPair(context.tabsAxis, tabName)],
      };
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
  const variant = variantStringOf(context);
  if (variant !== undefined) setStringAttribute(element, "data-variant", variant);
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
    const frontmatter = frontmatterFrom(file) ?? {};
    const axes = axisDeclarationFrom(frontmatter);
    transformChildren(tree, {
      guideId,
      scenarioId: undefined,
      tabsAxis: undefined,
      selectedPairs: [],
      axisSelections: {},
      sourceFile: sourceFileFrom(file),
      source: typeof file.value === "string" ? file.value : undefined,
      hasTabsDeclaration: axes.hasTabsDeclaration,
      axisOrder: axes.axisOrder,
      axisDefaults: axes.axisDefaults,
    });
  };
