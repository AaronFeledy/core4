import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Root, Text } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import {
  type MdxJsxAttribute,
  type MdxJsxFlowElement,
  type MdxJsxTextElement,
  mdxFromMarkdown,
} from "mdast-util-mdx";
import { mdxjs } from "micromark-extension-mdxjs";
import type { Node, Parent } from "unist";
import { VFile } from "vfile";

import { remarkGuideContext } from "../src/plugins/remark-guide-context.ts";

type MdxElement = MdxJsxFlowElement | MdxJsxTextElement;

const isParent = (node: Node): node is Parent => "children" in node && Array.isArray(node.children);

const isMdxElement = (node: Node): node is MdxElement =>
  node.type === "mdxJsxFlowElement" || node.type === "mdxJsxTextElement";

const isText = (node: Node): node is Text => node.type === "text";

const parseAndTransform = (source: string, guideId = "guide-one"): Root => {
  const tree = fromMarkdown(source, {
    extensions: [mdxjs()],
    mdastExtensions: [mdxFromMarkdown()],
  });
  const file = new VFile({
    value: source,
    path: join(process.cwd(), "docs", "guides", "fixture.mdx"),
    data: { astro: { frontmatter: { id: guideId } } },
  });

  remarkGuideContext()(tree, file);

  return tree;
};

const descendants = (tree: Root): readonly Node[] => {
  const nodes: Node[] = [];
  const collect = (node: Node): void => {
    nodes.push(node);
    if (!isParent(node)) return;
    for (const child of node.children) collect(child);
  };
  collect(tree);
  return nodes;
};

const elementsNamed = (tree: Root, name: string): readonly MdxElement[] =>
  descendants(tree).filter((node): node is MdxElement => isMdxElement(node) && node.name === name);

const elementNamed = (tree: Root, name: string): MdxElement => {
  const element = elementsNamed(tree, name)[0];
  if (element === undefined) throw new RangeError(`Expected an MDX element named ${name}.`);
  return element;
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

const text = (tree: Root): string =>
  descendants(tree)
    .filter(isText)
    .map((node) => node.value)
    .join("");

describe("remark guide context", () => {
  test("injects guide and enclosing scenario ids across multiple scenarios", () => {
    // Given: two scenarios containing the reader-facing guide vocabulary.
    const source = `<Scenario id="first">
  <Step><Run /><Verify /></Step>
</Scenario>

<Scenario id="second">
  <Inspect /><Cleanup /><Inline />
</Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source, "context-guide");

    // Then: each component receives the authoritative guide and nearest scenario ids.
    expect(
      ["Step", "Run", "Verify", "Inspect", "Cleanup", "Inline"].map((name) => {
        const element = elementNamed(tree, name);
        return [
          name,
          stringAttribute(element, "data-guide-id"),
          stringAttribute(element, "data-scenario-id"),
          stringAttribute(element, "data-source-file"),
          stringAttribute(element, "data-source-line"),
        ];
      }),
    ).toEqual([
      ["Step", "context-guide", "first", "docs/guides/fixture.mdx", "2"],
      ["Run", "context-guide", "first", "docs/guides/fixture.mdx", "2"],
      ["Verify", "context-guide", "first", "docs/guides/fixture.mdx", "2"],
      ["Inspect", "context-guide", "second", "docs/guides/fixture.mdx", "6"],
      ["Cleanup", "context-guide", "second", "docs/guides/fixture.mdx", "6"],
      ["Inline", "context-guide", "second", "docs/guides/fixture.mdx", "6"],
    ]);
  });

  test("injects only the guide id outside a scenario", () => {
    // Given: guide components that are not enclosed by a Scenario.
    const source = `<Run />

<Tab name="Outside">content</Tab>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source, "outside-guide");

    // Then: components receive guide context without invented scenario context.
    expect(
      ["Run", "Tab"].map((name) => {
        const element = elementNamed(tree, name);
        return [stringAttribute(element, "data-guide-id"), attributeNamed(element, "data-scenario-id")];
      }),
    ).toEqual([
      ["outside-guide", undefined],
      ["outside-guide", undefined],
    ]);
  });

  test("removes Hidden subtrees in flow and inline positions", () => {
    // Given: public prose surrounding inline and flow Hidden blocks.
    const source = `Visible before <Hidden reason="internal">inline secret</Hidden> visible after.

<Hidden reason="internal">
flow secret
<Run />
</Hidden>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source);

    // Then: Hidden elements and all descendants are absent while public prose survives.
    expect({ hiddenCount: elementsNamed(tree, "Hidden").length, renderedText: text(tree) }).toEqual({
      hiddenCount: 0,
      renderedText: "Visible before  visible after.",
    });
  });

  test("removes only scenarios whose render expression is false", () => {
    // Given: hidden, explicitly rendered, and default-rendered scenarios.
    const source = `<Scenario id="hidden" render={false}><Run command="test-only-secret" /></Scenario>

<Scenario id="explicit" render><Run /></Scenario>

<Scenario id="default"><Verify /></Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source);

    // Then: the false-render subtree is gone and both public render forms survive.
    expect(elementsNamed(tree, "Scenario").map((element) => stringAttribute(element, "id"))).toEqual([
      "explicit",
      "default",
    ]);
    expect(text(tree)).not.toContain("test-only-secret");
  });

  test("preserves Tabs and annotates each Tab with its static axis and name", () => {
    // Given: synchronized tabs nested in a rendered scenario.
    const source = `<Scenario id="database-choice">
  <Tabs axis="database">
    <Tab name="Postgres"><Run /></Tab>
    <Tab name="MySQL"><Verify /></Tab>
  </Tabs>
</Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source, "tabs-guide");

    // Then: the tab structure and authored attributes survive with frame context added.
    expect({
      axis: stringAttribute(elementNamed(tree, "Tabs"), "axis"),
      tabs: elementsNamed(tree, "Tab").map((element) => ({
        name: stringAttribute(element, "name"),
        guideId: stringAttribute(element, "data-guide-id"),
        scenarioId: stringAttribute(element, "data-scenario-id"),
        dataAxis: stringAttribute(element, "data-axis"),
        tabName: stringAttribute(element, "data-tab-name"),
        variant: stringAttribute(element, "data-variant"),
      })),
    }).toEqual({
      axis: "database",
      tabs: [
        {
          name: "Postgres",
          guideId: "tabs-guide",
          scenarioId: "database-choice",
          dataAxis: "database",
          tabName: "Postgres",
          variant: "database=Postgres",
        },
        {
          name: "MySQL",
          guideId: "tabs-guide",
          scenarioId: "database-choice",
          dataAxis: "database",
          tabName: "MySQL",
          variant: "database=MySQL",
        },
      ],
    });
  });

  test("turns flow and text expressions into prose without changing attribute expressions", () => {
    // Given: stray prose expressions beside valid code and render attribute expressions.
    const source = `Use { RuntimeProvider } here.

{
  RuntimeProvider
}

<Run code={\`x\`} />

<Scenario id="kept" render={true}><Verify /></Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source);

    // Then: prose braces render literally and attribute expressions retain their AST values.
    expect(descendants(tree).map((node) => node.type)).not.toContain("mdxTextExpression");
    expect(descendants(tree).map((node) => node.type)).not.toContain("mdxFlowExpression");
    expect(text(tree)).toContain("Use { RuntimeProvider } here.");
    expect(text(tree)).toContain("{\n  RuntimeProvider\n}");
    expect(attributeNamed(elementNamed(tree, "Run"), "code")?.value).toMatchObject({
      type: "mdxJsxAttributeValueExpression",
      value: "`x`",
    });
    expect(attributeNamed(elementNamed(tree, "Scenario"), "render")?.value).toMatchObject({
      type: "mdxJsxAttributeValueExpression",
      value: "true",
    });
  });

  test("does not introduce MDX import or export nodes", () => {
    // Given: guide MDX with no authored ESM nodes.
    const source = `<Scenario id="plain"><Run /></Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source);

    // Then: context injection remains an AST-only attribute transformation.
    expect(descendants(tree).map((node) => node.type)).not.toContain("mdxjsEsm");
  });
});
