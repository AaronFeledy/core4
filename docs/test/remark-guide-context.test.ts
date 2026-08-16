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

const parseAndTransform = (
  source: string,
  guideId = "guide-one",
  frontmatter: Readonly<Record<string, unknown>> = {},
): Root => {
  const tree = fromMarkdown(source, {
    extensions: [mdxjs()],
    mdastExtensions: [mdxFromMarkdown()],
  });
  const file = new VFile({
    value: source,
    path: join(process.cwd(), "docs", "guides", "fixture.mdx"),
    data: { astro: { frontmatter: { id: guideId, ...frontmatter } } },
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

  test("derives default axis from frontmatter tabs for axisless Tabs", () => {
    // Given: frontmatter tabs declaration and Tabs without an axis attribute.
    const source = `<Scenario id="pick">
  <Tabs>
    <Tab name="Postgres"><Run /></Tab>
    <Tab name="MySQL"><Verify /></Tab>
  </Tabs>
</Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source, "tabs-default-guide", {
      tabs: ["Postgres", "MySQL"],
    });

    // Then: Tab and descendant Run receive default-axis data-axis and data-variant.
    const postgresTab = elementsNamed(tree, "Tab").find(
      (element) => stringAttribute(element, "name") === "Postgres",
    );
    if (postgresTab === undefined) throw new RangeError("Expected Postgres Tab.");
    expect({
      tabAxis: stringAttribute(postgresTab, "data-axis"),
      tabVariant: stringAttribute(postgresTab, "data-variant"),
      tabName: stringAttribute(postgresTab, "data-tab-name"),
      run: {
        axis: stringAttribute(elementNamed(tree, "Run"), "data-axis"),
        variant: stringAttribute(elementNamed(tree, "Run"), "data-variant"),
        scenarioId: stringAttribute(elementNamed(tree, "Run"), "data-scenario-id"),
      },
      mysql: (() => {
        const mysqlTab = elementsNamed(tree, "Tab").find(
          (element) => stringAttribute(element, "name") === "MySQL",
        );
        if (mysqlTab === undefined) throw new RangeError("Expected MySQL Tab.");
        return {
          axis: stringAttribute(mysqlTab, "data-axis"),
          variant: stringAttribute(mysqlTab, "data-variant"),
        };
      })(),
    }).toEqual({
      tabAxis: "default",
      tabVariant: "default=Postgres",
      tabName: "Postgres",
      run: {
        axis: undefined,
        variant: "default=Postgres",
        scenarioId: "pick",
      },
      mysql: {
        axis: "default",
        variant: "default=MySQL",
      },
    });
  });

  test("infers the sole declared axes key when Tabs omits axis", () => {
    // Given: a single axes entry and axisless Tabs under a scenario.
    const source = `<Scenario id="database-choice">
  <Tabs>
    <Tab name="Postgres"><Run /></Tab>
  </Tabs>
</Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source, "single-axis-guide", {
      axes: { database: ["Postgres", "MySQL"] },
    });

    // Then: Tab and descendant Run use the inferred axis token in data attributes.
    expect({
      tabs: elementsNamed(tree, "Tab").map((element) => ({
        dataAxis: stringAttribute(element, "data-axis"),
        tabName: stringAttribute(element, "data-tab-name"),
        variant: stringAttribute(element, "data-variant"),
      })),
      run: {
        variant: stringAttribute(elementNamed(tree, "Run"), "data-variant"),
        guideId: stringAttribute(elementNamed(tree, "Run"), "data-guide-id"),
        scenarioId: stringAttribute(elementNamed(tree, "Run"), "data-scenario-id"),
      },
    }).toEqual({
      tabs: [
        {
          dataAxis: "database",
          tabName: "Postgres",
          variant: "database=Postgres",
        },
      ],
      run: {
        variant: "database=Postgres",
        guideId: "single-axis-guide",
        scenarioId: "database-choice",
      },
    });
  });

  test("completes sibling multi-axis Tabs with first declared values in declaration order", () => {
    // Given: two sibling Tabs axes and multi-axis frontmatter in declaration order.
    const source = `<Scenario id="matrix">
  <Tabs axis="os">
    <Tab name="macos"><Run /></Tab>
    <Tab name="linux"><Verify /></Tab>
  </Tabs>
  <Tabs axis="package-manager">
    <Tab name="npm"><Run /></Tab>
    <Tab name="composer"><Inspect /></Tab>
  </Tabs>
</Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source, "matrix-guide", {
      axes: {
        os: ["linux", "macos"],
        "package-manager": ["composer", "npm"],
      },
    });

    // Then: each tab fills unresolved axes with first declared values; pairs stay declaration-ordered.
    const tabByName = (name: string): MdxElement => {
      const tab = elementsNamed(tree, "Tab").find((element) => stringAttribute(element, "name") === name);
      if (tab === undefined) throw new RangeError(`Expected Tab name=${name}.`);
      return tab;
    };
    const runUnder = (tabName: string): MdxElement => {
      const tab = tabByName(tabName);
      const run = tab.children.find(
        (child): child is MdxElement => isMdxElement(child) && child.name === "Run",
      );
      if (run === undefined) throw new RangeError(`Expected Run under Tab ${tabName}.`);
      return run;
    };
    expect({
      macos: {
        tab: stringAttribute(tabByName("macos"), "data-variant"),
        run: stringAttribute(runUnder("macos"), "data-variant"),
        axis: stringAttribute(tabByName("macos"), "data-axis"),
      },
      npm: {
        tab: stringAttribute(tabByName("npm"), "data-variant"),
        run: stringAttribute(runUnder("npm"), "data-variant"),
        axis: stringAttribute(tabByName("npm"), "data-axis"),
      },
      linux: stringAttribute(tabByName("linux"), "data-variant"),
      composer: stringAttribute(tabByName("composer"), "data-variant"),
    }).toEqual({
      macos: {
        tab: "os=macos package-manager=composer",
        run: "os=macos package-manager=composer",
        axis: "os",
      },
      npm: {
        tab: "os=linux package-manager=npm",
        run: "os=linux package-manager=npm",
        axis: "package-manager",
      },
      linux: "os=linux package-manager=composer",
      composer: "os=linux package-manager=composer",
    });
  });

  test("nested multi-axis Tabs emit declaration-ordered complete variants", () => {
    // Given: nested Tabs whose DOM axis order differs from frontmatter declaration order.
    const source = `<Scenario id="nested">
  <Tabs axis="package-manager">
    <Tab name="npm">
      <Tabs axis="os">
        <Tab name="macos"><Run /></Tab>
      </Tabs>
    </Tab>
  </Tabs>
</Scenario>`;

    // When: the guide context transformer processes the MDX tree.
    const tree = parseAndTransform(source, "nested-guide", {
      axes: {
        os: ["linux", "macos"],
        "package-manager": ["composer", "npm"],
      },
    });

    // Then: data-variant uses declaration order even though package-manager wraps os in the DOM.
    const tabNamed = (name: string): MdxElement => {
      const tab = elementsNamed(tree, "Tab").find((element) => stringAttribute(element, "name") === name);
      if (tab === undefined) throw new RangeError(`Expected Tab name=${name}.`);
      return tab;
    };
    expect({
      outer: stringAttribute(tabNamed("npm"), "data-variant"),
      inner: stringAttribute(tabNamed("macos"), "data-variant"),
      run: stringAttribute(elementNamed(tree, "Run"), "data-variant"),
    }).toEqual({
      outer: "os=linux package-manager=npm",
      inner: "os=macos package-manager=npm",
      run: "os=macos package-manager=npm",
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
