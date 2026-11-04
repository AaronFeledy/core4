import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseGuideScenarioAst, processor } from "@lando/core/docs/guide-compiler";
import type { Root } from "mdast";
import type { MdxJsxFlowElement } from "mdast-util-mdx";
import remarkParse from "remark-parse";
import { unified } from "unified";
import { VFile } from "vfile";
import { serializeDocsPage } from "../src/lib/llms.ts";
import { remarkGuideContext } from "../src/plugins/remark-guide-context.ts";

const file = resolve(import.meta.dirname, "../guides/fixture.mdx");
const document = (body: string, extra = "") =>
  `---\nid: context-guide\n${extra}---\n\n<Guide>\n${body}\n</Guide>`;
const scenario = (body: string) => `<Scenario id="reader">\n${body}\n</Scenario>`;
const step = (body: string, name = "action") => `<Step name="${name}">${body}</Step>`;
const transform = (source: string): Root => {
  const root = processor.parse(source);
  // Astro supplies enriched frontmatter; authored YAML is still available in this fixture.
  const fm = { id: "context-guide" };
  remarkGuideContext()(root, new VFile({ path: file, value: source, data: { astro: { frontmatter: fm } } }));
  return root;
};
const elements = (root: Root, name: string): MdxJsxFlowElement[] => {
  const found: MdxJsxFlowElement[] = [];
  const visit = (node: { type: string; name?: string | null; children?: readonly unknown[] }) => {
    if (node.type === "mdxJsxFlowElement" && node.name === name) found.push(node as MdxJsxFlowElement);
    for (const child of node.children ?? []) visit(child as Parameters<typeof visit>[0]);
  };
  visit(root);
  return found;
};
const attr = (node: MdxJsxFlowElement | undefined, name: string) =>
  node?.attributes.find((attr) => attr.type === "mdxJsxAttribute" && attr.name === name)?.value;

const matrix = document(
  scenario(`
<Tabs axis="a">
<Tab name="a1">${step('<Variable name="target" value="private-one" display="public-one" />', "binding")}</Tab>
<Tab name="a2">${step('<Variable name="target" value="private-two" display="public-two" />', "binding")}</Tab>
</Tabs>
${step('<Run command="echo {{target}}" answers={{ token: "private-answer" }} /><Run command="second {{target}}" />', "common")}
<Tabs axis="b">
<Tab name="b1">${step('<Run command="b1 {{target}}" />', "other")}</Tab>
<Tab name="b2">${step('<Run command="b2 {{target}}" />', "other")}</Tab>
</Tabs>`),
  "axes:\n  a: [a1, a2]\n  b: [b1, b2]\n",
);

describe("canonical guide presentation", () => {
  test("keeps every tab and chooses matching display values and complete transcript variants", () => {
    const root = transform(matrix);
    expect(elements(root, "Tab").map((tab) => attr(tab, "name"))).toEqual(["a1", "a2", "b1", "b2"]);
    const runs = elements(root, "Run");
    expect(runs.map((run) => [attr(run, "command"), attr(run, "data-variant")])).toEqual([
      ["echo public-one", "a=a1 b=b1"],
      ["second public-one", "a=a1 b=b1"],
      ["b1 public-one", "a=a1 b=b1"],
      ["b2 public-one", "a=a1 b=b2"],
    ]);
    expect(runs.map((run) => attr(run, "data-scenario-id"))).toEqual([
      "reader",
      "reader",
      "reader",
      "reader",
    ]);
    expect(attr(runs[0], "data-source-file")).toBe("docs/guides/fixture.mdx");
    expect(attr(runs[0], "data-source-line")).toBeDefined();
    expect(attr(runs[0], "answers")).toBeUndefined();
    expect(elements(root, "Variable").map((node) => attr(node, "value"))).toEqual([
      "public-one",
      "public-two",
    ]);
    const markdown = serializeDocsPage(matrix, { file });
    for (const value of ["public-one", "public-two", "b1 public-one", "b2 public-one"])
      expect(markdown).toContain(value);
    expect(JSON.stringify(root) + markdown).not.toContain("private-");
  });

  test("never reinterpolates inserted display text", () => {
    const source = document(
      scenario(
        step(
          '<Variable name="target" value="execution" display="{{literal}}" /><Run command="echo {{target}}" />',
        ),
      ),
    );
    expect(serializeDocsPage(source, { file })).toContain("echo {{literal}}");
    expect(attr(elements(transform(source), "Run")[0], "command")).toBe("echo {{literal}}");
  });

  test("drops private shell answers from the site tree and public Markdown", () => {
    const source = document(
      scenario(step('<Run shell="echo public" answers={{ token: "shell-answer-secret" }} />')),
    );
    const root = transform(source);
    expect(attr(elements(root, "Run")[0], "shell")).toBe("echo public");
    expect(attr(elements(root, "Run")[0], "answers")).toBeUndefined();
    expect(JSON.stringify(root)).not.toContain("shell-answer-secret");
    expect(serializeDocsPage(source, { file })).not.toContain("shell-answer-secret");
  });

  test("removes test-only content and exposes only library display code without transcripts", () => {
    const source = document(
      `<Scenario id="reader">\n${step('<Run runtime="library" code={`expect(true).toBe(true); /* execution-secret */`} displayCode={`read("{{opaque}}");`} />')}\n<Hidden reason="private setup">${step('<Run runtime="library" code="private-hidden" displayCode="hidden" />', "hidden")}</Hidden>\n</Scenario>\n<Scenario id="private" render={false} reason="Only for internal regression">${step('<Run command="private-command" />')}</Scenario>`,
    );
    const root = transform(source);
    expect(elements(root, "Scenario")).toHaveLength(1);
    expect(elements(root, "Hidden")).toHaveLength(0);
    expect(attr(elements(root, "Run")[0], "code")).toBe('read("{{opaque}}");');
    expect(JSON.stringify(root) + serializeDocsPage(source, { file })).not.toMatch(
      /execution-secret|private-command|private-hidden/,
    );
  });

  test.each([
    ["malformed run", document(scenario(step('<Run command="x" shell="y" />')))],
    [
      "identical duplicates",
      document(
        scenario(
          step('<Variable name="x" value="same" /><Variable name="x" value="same" /><Run command="{{x}}" />'),
        ),
      ),
    ],
    [
      "hidden reference",
      document(
        scenario(
          `<Hidden reason="private setup">${step('<Variable name="x" value="secret" />', "binding")}</Hidden>\n${step('<Run command="{{x}}" />')}`,
        ),
      ),
    ],
    [
      "invalid nondefault cell",
      matrix.replace(
        'value="private-two" display="public-two" />',
        'value="private-two" display="public-two" /><Variable name="target" value="same" />',
      ),
    ],
    ["nested Guide", document(scenario(`<Guide>\n${scenario(step('<Run command="x" />'))}\n</Guide>`))],
  ])("aligns source-located failures for %s", (_name, source) => {
    const failures = [
      () => parseGuideScenarioAst(file, source),
      () => serializeDocsPage(source, { file }),
      () => transform(source),
    ].map((run) => {
      try {
        run();
        throw new Error("Expected rejection");
      } catch (error) {
        return error as { code: string; line: number; sourcePath: string };
      }
    });
    expect(failures[0]?.code).toBeDefined();
    for (const failure of failures.slice(1))
      expect([failure.code, failure.line, failure.sourcePath]).toEqual([
        failures[0]?.code,
        failures[0]?.line,
        file,
      ]);
  });

  test("allows rich non-guide MDX beside a valid Guide and preserves standalone prose behavior", () => {
    const source = document(scenario(step('<Run command="version" />'))).replace(
      "<Guide>",
      '<div className="note"><span>Rich **prose**</span></div>\n\n<Guide>',
    );
    expect(serializeDocsPage(source, { file })).toContain("Rich **prose**");
    expect(JSON.stringify(transform(source))).toContain('"value":"Rich "');
    expect(JSON.stringify(transform(source))).toContain('"value":"prose"');
    const standalone = transform("Use { RuntimeProvider } here.\n\n<div><span>Ordinary prose</span></div>");
    expect(JSON.stringify(standalone)).toContain("{ RuntimeProvider }");
    expect(JSON.stringify(standalone)).toContain("Ordinary prose");
  });

  test("preserves prose expressions, annotates exact source lines, and adds no ESM", () => {
    const source = document(scenario(`Use { RuntimeProvider } here.\n${step('<Run command="version" />')}`));
    const root = transform(source);
    const run = elements(root, "Run")[0];
    expect(JSON.stringify(root)).toContain("{ RuntimeProvider }");
    expect(attr(run, "data-guide-id")).toBe("context-guide");
    expect(attr(run, "data-source-file")).toBe("docs/guides/fixture.mdx");
    expect(attr(run, "data-source-line")).toBe(String(run?.position?.start.line));
    expect(attr(run, "data-scenario-id")).toBe("reader");
    expect(JSON.stringify(root)).not.toContain("mdxjsEsm");
  });

  test("uses the sole declared axis for axisless Tabs and removes Skip", () => {
    const source = document(
      scenario(
        `<Tabs>\n<Tab name="linux">${step('<Run command="linux" />')}</Tab>\n<Tab name="macos">${step('<Run command="macos" />')}</Tab>\n</Tabs>\n<Skip reason="Future coverage">${step('<Run command="private-skip" />', "skipped")}</Skip>`,
      ),
      "tabs: [linux, macos]\n",
    );
    const root = transform(source);
    expect(
      elements(root, "Tab").map((tab) => [
        attr(tab, "data-axis"),
        attr(tab, "data-tab-name"),
        attr(tab, "data-variant"),
      ]),
    ).toEqual([
      ["default", "linux", "default=linux"],
      ["default", "macos", "default=macos"],
    ]);
    expect(elements(root, "Skip")).toHaveLength(0);
    expect(JSON.stringify(root)).not.toContain("private-skip");
  });

  test("validates a Guide even when Astro metadata has no id", () => {
    const source =
      '<Guide><Scenario id="reader"><Step name="run"><Run command="version" /></Step></Scenario></Guide>';
    const root = processor.parse(source);
    expect(() =>
      remarkGuideContext()(
        root,
        new VFile({ path: file, value: source, data: { astro: { frontmatter: {} } } }),
      ),
    ).toThrow();
  });

  test("keeps ordinary Markdown with an id outside the guide MDX parser", () => {
    const source = "---\nid: prose-page\n---\n\nOrdinary Markdown: {not JavaScript} and 2 < 3.";
    const root = unified().use(remarkParse).parse(source);
    remarkGuideContext()(
      root,
      new VFile({ path: file, value: source, data: { astro: { frontmatter: { id: "prose-page" } } } }),
    );
    expect(JSON.stringify(root)).toContain("{not JavaScript} and 2 < 3.");
  });
});
