import { describe, expect, test } from "bun:test";
import type { Heading, Root } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import { mdxFromMarkdown } from "mdast-util-mdx";
import { mdxjs } from "micromark-extension-mdxjs";

import { remarkDropLeadingHeading } from "../src/plugins/remark-drop-leading-heading.ts";

const parseAndTransform = (source: string): Root => {
  const tree = fromMarkdown(source, {
    extensions: [mdxjs()],
    mdastExtensions: [mdxFromMarkdown()],
  });
  remarkDropLeadingHeading()(tree);
  return tree;
};

const headingDepths = (tree: Root): readonly Heading["depth"][] =>
  tree.children.filter((node): node is Heading => node.type === "heading").map((heading) => heading.depth);

describe("remark drop leading heading", () => {
  test("removes a leading h1 when it is the document's first heading", () => {
    // Given: a document whose first node is an h1 followed by a subsection.
    const source = "# Page title\n\n## First section";

    // When: the leading-heading transform processes the document.
    const tree = parseAndTransform(source);

    // Then: only the subsection heading remains.
    expect(headingDepths(tree)).toEqual([2]);
  });

  test("removes a leading h1 after a non-rendering MDX comment", () => {
    // Given: a generated-file comment before the document's leading h1.
    const source = "{/* generated file */}\n\n# Page title\n\n## First section";

    // When: the leading-heading transform processes the document.
    const tree = parseAndTransform(source);

    // Then: the comment remains while only the subsection heading renders.
    expect({ nodeTypes: tree.children.map((node) => node.type), depths: headingDepths(tree) }).toEqual({
      nodeTypes: ["mdxFlowExpression", "heading"],
      depths: [2],
    });
  });

  test("preserves a document whose first heading is h2", () => {
    // Given: an h2 before a later h1.
    const source = "## First section\n\n# Later heading";

    // When: the leading-heading transform processes the document.
    const tree = parseAndTransform(source);

    // Then: neither heading is removed.
    expect(headingDepths(tree)).toEqual([2, 1]);
  });

  test("preserves an h1 that appears after prose", () => {
    // Given: prose before the document's h1.
    const source = "Introductory prose.\n\n# Mid-document heading";

    // When: the leading-heading transform processes the document.
    const tree = parseAndTransform(source);

    // Then: the prose and mid-document h1 both remain.
    expect({ nodeTypes: tree.children.map((node) => node.type), depths: headingDepths(tree) }).toEqual({
      nodeTypes: ["paragraph", "heading"],
      depths: [1],
    });
  });

  test("handles an empty document", () => {
    // Given: an empty document.
    const source = "";

    // When: the leading-heading transform processes the document.
    const tree = parseAndTransform(source);

    // Then: the document stays empty.
    expect(tree.children).toEqual([]);
  });

  test("preserves a document containing only prose", () => {
    // Given: a document with prose and no headings.
    const source = "Only prose belongs in this document.";

    // When: the leading-heading transform processes the document.
    const tree = parseAndTransform(source);

    // Then: the prose node remains intact.
    expect(tree.children.map((node) => node.type)).toEqual(["paragraph"]);
  });
});
