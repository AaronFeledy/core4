import { encodeVariantPair, encodeVariantString } from "@lando/core/docs/variant";
import type { Root } from "mdast";
import type { MdxNode } from "./mdx.ts";
import { elementChildren } from "./mdx.ts";
import type { GuideStepComponent, ResolvedScenario } from "./model.ts";
import { parseGuideRoot } from "./parser.ts";

export interface PresentationContext {
  readonly guideId: string;
  readonly scenarioId?: string;
  readonly variant?: string;
  readonly axis?: string;
  readonly tabName?: string;
}
export interface GuidePresentation {
  readonly guideId: string;
  readonly contexts: ReadonlyMap<MdxNode, PresentationContext>;
}

const toExpression = (value: unknown): unknown =>
  Array.isArray(value)
    ? { type: "ArrayExpression", elements: value.map(toExpression) }
    : value !== null && typeof value === "object"
      ? {
          type: "ObjectExpression",
          properties: Object.entries(value).map(([key, value]) => ({
            type: "Property",
            kind: "init",
            key: { type: "Literal", value: key },
            value: toExpression(value),
          })),
        }
      : { type: "Literal", value };

const publicProps = (component: GuideStepComponent): Record<string, unknown> => {
  const props = component.props;
  if (component.kind === "Variable")
    return { ...props, value: component.props.display ?? component.props.value };
  if (component.kind === "Run") {
    if ("runtime" in component.props)
      return {
        runtime: "library",
        code: component.props.displayCode,
        displayCode: component.props.displayCode,
      };
    const { answers: _answers, ...display } = component.props;
    return display;
  }
  return { ...props };
};

/** Validate every canonical cell before projecting all authored tabs in place. */
export const projectGuidePresentation = (
  sourcePath: string,
  root: Root,
  frontmatter?: Record<string, unknown>,
): GuidePresentation | undefined => {
  // Non-guide pages retain their ordinary Markdown/MDX grammar.
  const containsGuide = (node: MdxNode): boolean =>
    node.name === "Guide" || (node.children ?? []).some(containsGuide);
  if (!containsGuide(root)) return undefined;
  const guide = parseGuideRoot(sourcePath, root, {
    presentation: true,
    ...(frontmatter === undefined ? {} : { frontmatter }),
  });
  const contexts = new Map<MdxNode, PresentationContext>();
  type MutableNode = { attributes?: unknown[]; children?: MdxNode[] };
  const setProps = (node: MdxNode, props: Record<string, unknown>) => {
    (node as unknown as MutableNode).attributes = Object.entries(props)
      .filter(([, value]) => value !== undefined)
      .map(([name, value]) => ({
        type: "mdxJsxAttribute",
        name,
        value:
          typeof value === "string"
            ? value
            : {
                type: "mdxJsxAttributeValueExpression",
                value: JSON.stringify(value),
                data: {
                  estree: { body: [{ type: "ExpressionStatement", expression: toExpression(value) }] },
                },
              },
      }));
  };
  const variantOf = (cell: ResolvedScenario | undefined) => {
    const pairs = cell?.variant?.pairs ?? [];
    return pairs.length === 0
      ? undefined
      : encodeVariantString(pairs.map(({ axis, value }) => encodeVariantPair(axis, value)));
  };
  const visit = (
    node: MdxNode,
    cells: readonly ResolvedScenario[],
    inherited?: ResolvedScenario,
    scenarioId?: string,
  ): void => {
    const scenario = guide.scenarios.find((candidate) => candidate.source === node);
    const scopedCells =
      scenario === undefined
        ? cells
        : guide.cells.filter((cell) => cell.scenarioId === scenario.id).map((cell) => cell.resolved);
    const id = scenario?.id ?? scenarioId;
    // Each authored public node selects its first compatible canonical cell. Sibling axes
    // therefore complete with their first declared values, exactly as transcript generation does.
    const representative =
      scopedCells.find(
        (cell) =>
          cell.publicSteps.some(
            (step) => step.source === node || step.components.some((component) => component.source === node),
          ) || cell.tabs.some((tab) => tab.source === node),
      ) ?? (scenario === undefined ? inherited : scopedCells[0]);
    const component = representative?.publicSteps
      .flatMap((step) => step.components)
      .find((component) => component.source === node);
    const tab = representative?.tabs.find((tab) => tab.source === node);
    const variant = variantOf(representative);
    if (component !== undefined) setProps(node, publicProps(component));
    if (node.name !== undefined && node.name !== null)
      contexts.set(node, {
        guideId: guide.frontmatter.id,
        ...(id === undefined ? {} : { scenarioId: id }),
        ...(variant === undefined ? {} : { variant }),
        ...(tab === undefined ? {} : { axis: tab.axis, tabName: tab.value }),
      });
    if (node.children !== undefined) {
      const children = node.children.filter(
        (child) =>
          child.name !== "Hidden" &&
          child.name !== "Skip" &&
          child.name !== "Cleanup" &&
          !(
            child.name === "Scenario" &&
            guide.scenarios.find((candidate) => candidate.source === child)?.render === false
          ),
      );
      (node as unknown as MutableNode).children = [...children];
      for (const child of children) visit(child, scopedCells, representative, id);
    }
  };
  for (const node of elementChildren(root).filter((node) => node.name === "Guide")) visit(node, []);
  return { guideId: guide.frontmatter.id, contexts };
};
